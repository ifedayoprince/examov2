import fs from 'fs-extra';
import path from 'node:path';
// @ts-ignore
import pandoc from 'node-pandoc';

const STATE_FILE = './output/.examo_state.json';
const OUTPUT_DIR = './output';
const TEMPLATE_PATH = './files/template.docx';

function cleanLatex(content) {
    return content
        .replace(/^%.*$/gm, '')
        .replace(/^\s*\\setcounter\{enumi\}\{\d+\}.*$/gm, '')
        .replace(/\\end\{enumerate\}\s*\\begin\{enumerate\}(\[resume\])?/g, '\n')
        .replace(/\\begin\{enumerate\}\[resume\]/g, '\\begin{enumerate}')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function generateHeader(cls, subj) {
    const displaySubj = (subj || 'Unknown Subject').replace(/_/g, ' ');
    const displayCls = (cls || 'Unknown Class').replace(/_/g, ' ');
    return [
        '\\begin{flushleft}\\textbf{NAME: ____________________________}\\end{flushleft}',
        `\\begin{flushleft}\\textbf{\\uppercase{SUBJECT: ${displaySubj}}}\\end{flushleft}`,
        `\\begin{flushleft}\\textbf{\\uppercase{CLASS: ${displayCls}}}\\end{flushleft}`,
        '\\begin{flushleft}\\textbf{DATE: ____________________________}\\end{flushleft}',
        '',
        ''
    ].join('\n');
}

function extractFirstQuestion(latex) {
    const match = latex.match(/\\item\s+([^\\{[]+)/);
    if (match && match[1]) {
        return match[1].trim().substring(0, 100) + (match[1].trim().length > 100 ? '...' : '');
    }
    return 'No question text detected.';
}

async function compile(texPath, docxPath) {
    const args = [
        '-f', 'latex',
        '-t', 'docx',
        '--reference-doc', TEMPLATE_PATH,
        '-o', docxPath,
    ];

    return new Promise((resolve, reject) => {
        pandoc(texPath, args, (err) => {
            if (err) reject(err);
            else resolve(docxPath);
        });
    });
}

async function migrate() {
    if (!(await fs.pathExists(STATE_FILE))) {
        console.error('State file not found at', STATE_FILE);
        return;
    }

    if (!(await fs.pathExists(TEMPLATE_PATH))) {
        console.error('Template file not found at', TEMPLATE_PATH);
        return;
    }

    // 0. Clear output dir except state file
    console.log('Clearing old output files (keeping cache)...');
    const items = await fs.readdir(OUTPUT_DIR);
    for (const item of items) {
        if (item === '.examo_state.json') continue;
        await fs.remove(path.join(OUTPUT_DIR, item));
    }

    const state = await fs.readJson(STATE_FILE);
    const pdfs = state.pdfs;

    let masterSummaryMd = `# All Processed Exams Summary\n`;
    masterSummaryMd += `This is a master list of every subject extracted from every PDF.Use ** Ctrl + F ** to find what you need.\n\n`;

    for (const [pdfFile, pdfData] of Object.entries(pdfs)) {
        console.log(`Processing ${pdfFile}...`);
        const pdfBaseName = path.basename(pdfFile, '.pdf');
        const pdfOutputDir = path.join(OUTPUT_DIR, pdfBaseName);
        const texOutputDir = path.join(pdfOutputDir, 'tex');

        await fs.ensureDir(texOutputDir);

        const summaryEntries = [];
        const completedChunks = pdfData.completedChunks || {};

        masterSummaryMd += `## 📂 Source PDF: ${pdfFile}\n\n`;

        // Sort chunks by index
        const sortedIndices = Object.keys(completedChunks).sort((a, b) => Number(a) - Number(b));

        for (const index of sortedIndices) {
            const chunk = completedChunks[index];
            const detectedClass = chunk.detected_class || 'UnknownClass';
            const detectedSubject = chunk.detected_subject || 'UnknownSubject';

            const sanitizedSubject = detectedSubject.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();

            const fileIndex = String(index).padStart(2, '0');
            const baseFileName = `${fileIndex} - ${sanitizedSubject}`;

            // 1. Reconstruct .tex file
            const texPath = path.join(texOutputDir, `${baseFileName}.tex`);
            const header = generateHeader(detectedClass, detectedSubject);
            const cleanContent = cleanLatex(chunk.latex_content);
            await fs.writeFile(texPath, header + cleanContent);

            // 2. Compile to .docx
            const docxPath = path.join(pdfOutputDir, `${baseFileName}.docx`);
            try {
                process.stdout.write(`  Compiling ${baseFileName}.docx... `);
                await compile(texPath, docxPath);
                process.stdout.write('Done\n');

                const firstQuestion = extractFirstQuestion(cleanContent);
                const entry = {
                    file: `${pdfBaseName} / ${baseFileName}.docx`,
                    shortFile: `${baseFileName}.docx`,
                    class: detectedClass,
                    subject: detectedSubject,
                    firstQuestion
                };
                summaryEntries.push(entry);

                // Add to master summary
                masterSummaryMd += `### 📄 ${entry.shortFile}\n`;
                masterSummaryMd += `- ** Class:** ${entry.class}\n`;
                masterSummaryMd += `- ** Subject:** ${entry.subject}\n`;
                masterSummaryMd += `- ** Question 1:** * "${firstQuestion}" *\n\n`;
            } catch (err) {
                console.error(`\n  ❌ Failed to compile ${baseFileName}: `, err);
                // Optionally add a note to master summary about the failure
                masterSummaryMd += `### ❌ ${baseFileName}.docx(FAILED TO COMPILE) \n`;
                masterSummaryMd += `> Error: Potential LaTeX syntax issue in raw transcription.\n\n`;
            }
        }

        masterSummaryMd += `-- -\n\n`;

        // 3. Generate individual SUMMARY.md
        const summaryPath = path.join(pdfOutputDir, 'SUMMARY.md');
        let summaryMd = `# Exam Subjects Found in: ${pdfFile}\n`;
        summaryMd += `This file helps you find which subject is in which Word document.You can press ** Ctrl + F ** to search for a subject name.\n\n-- -\n\n`;

        for (const entry of summaryEntries) {
            summaryMd += `### 📄 File: ${entry.shortFile} \n`;
            summaryMd += `- ** Subject:** ${entry.subject} \n`;
            summaryMd += `- ** Class:** ${entry.class} \n`;
            summaryMd += `- ** First Question:** * "${entry.firstQuestion}" *\n\n`;
            summaryMd += `-- -\n\n`;
        }
        await fs.writeFile(summaryPath, summaryMd);
    }

    // Write Master Summary
    await fs.writeFile(path.join(OUTPUT_DIR, 'SUMMARY.md'), masterSummaryMd);
    console.log('Generated Master SUMMARY.md at output root.');

    console.log('\nMigration and Recompilation complete!');
}

migrate().catch(console.error);
