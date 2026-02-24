import path from 'node:path';
import fs from 'fs-extra';
import type { AiResult } from './ai.service.js';

export interface FinalDocument {
    class: string;
    subject: string;
    texPath: string;
}

export class AssemblyService {
    private readonly outputDir: string;

    constructor(outputDir: string) {
        this.outputDir = outputDir;
    }

    async assemble(results: AiResult[]): Promise<FinalDocument[]> {
        // Flatten and sort by page number (CRITICAL for state machine)
        const allPages = results
            .flatMap((r) => r.pages)
            .sort((a, b) => a.page_number - b.page_number);

        let currentClass = 'UnknownClass';
        let currentSubject = 'UnknownSubject';
        const documents: Map<string, string[]> = new Map();

        for (const page of allPages) {
            if (page.is_new_section) {
                // If it's marked as a new section but missing names, try to update if present
                if (page.detected_class) currentClass = this.sanitize(page.detected_class);
                if (page.detected_subject) currentSubject = this.sanitize(page.detected_subject);
            } else if (page.detected_class && page.detected_subject) {
                // Check if this page introduces a new exam/header
                currentClass = this.sanitize(page.detected_class);
                currentSubject = this.sanitize(page.detected_subject);
            }

            const key = `${currentClass}/${currentSubject}`;
            if (!documents.has(key)) {
                documents.set(key, []);
            }
            documents.get(key)!.push(page.latex_content);
        }

        const finalDocs: FinalDocument[] = [];

        for (const [key, contents] of documents.entries()) {
            const parts = key.split('/');
            const cls = parts[0] || 'UnknownClass';
            const subj = parts[1] || 'UnknownSubject';

            const classDir = path.join(this.outputDir, cls);
            await fs.ensureDir(classDir);

            const texFileName = `${subj}.tex`;
            const texPath = path.join(classDir, texFileName);

            // Join and clean
            const rawContent = contents.join('\n\n');
            const cleanContent = AssemblyService.cleanLatex(rawContent);

            await fs.writeFile(texPath, cleanContent);

            finalDocs.push({ class: cls, subject: subj, texPath });
        }

        return finalDocs;
    }

    public static cleanLatex(content: string): string {
        return content
            // 1. Remove all comments (lines starting with %)
            .replace(/^%.*$/gm, '')
            // 2. Remove any \setcounter{enumi}{...} lines, even with leading spaces
            .replace(/^\s*\\setcounter\{enumi\}\{\d+\}.*$/gm, '')
            // 3. Merge adjacent enumerate environments that split across pages
            // This replaces \end{enumerate} [whitespace] \begin{enumerate} with just whitespace
            .replace(/\\end\{enumerate\}\s*\\begin\{enumerate\}(\[resume\])?/g, '\n')
            // 4. Remove any remaining [resume] from enumerate environments
            .replace(/\\begin\{enumerate\}\[resume\]/g, '\\begin{enumerate}')
            // 5. Clean up multiple newlines resulting from replacements
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    public static generateHeader(cls: string, subj: string): string {
        const displaySubj = subj.replace(/_/g, ' ');
        const displayCls = cls.replace(/_/g, ' ');

        return [
            '\\begin{left}\\textbf{NAME: ____________________________}\\end{left}',
            `\\begin{left}\\textbf{\\uppercase{SUBJECT: ${displaySubj}}}\\end{left}`,
            `\\begin{left}\\textbf{\\uppercase{CLASS: ${displayCls}}}\\end{left}`,
            '\\begin{left}\\textbf{DATE: ____________________________}\\end{left}',
            '',
            ''
        ].join('\n');
    }

    private sanitize(name: string): string {
        return name.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();
    }
}
