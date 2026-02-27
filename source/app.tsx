import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Spinner, ProgressBar } from '@inkjs/ui';
import fs from 'fs-extra';
import path from 'node:path';
import pLimit from 'p-limit';
import { PdfService } from './services/pdf.service.js';
import { AiService } from './services/ai.service.js';
import { AssemblyService } from './services/assembly.service.js';
import { CompilerService } from './services/compiler.service.js';
import { StateService } from './services/state.service.js';

type Props = {
	inputDir: string;
	outputDir: string;
	recompile?: boolean;
};

type ChunkStatus = {
	index: number;
	pages: string;
	progress: number;
	status: 'waiting' | 'processing' | 'done' | 'error';
};

export default function App({ inputDir, outputDir, recompile }: Props) {
	const [status, setStatus] = useState<string>('Initializing...');
	const [currentPdf, setCurrentPdf] = useState<string>('');
	const [totalPages, setTotalPages] = useState<number>(0);
	const [chunks, setChunks] = useState<ChunkStatus[]>([]);
	const [detections, setDetections] = useState<string[]>([]);
	const [compilations, setCompilations] = useState<{ name: string; status: 'done' | 'pending' }[]>([]);
	const [isFinished, setIsFinished] = useState(false);
	const [elapsedTime, setElapsedTime] = useState(0);

	useEffect(() => {
		const startTime = Date.now();
		const interval = setInterval(() => {
			if (!isFinished) {
				setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
			}
		}, 1000);

		const task = recompile ? recompileAll() : processPdfs();

		task.then(() => {
			setIsFinished(true);
			clearInterval(interval);
		});

		return () => clearInterval(interval);
	}, []);

	const recompileAll = async () => {
		const templatePath = './files/template.docx';
		const compilerService = new CompilerService(templatePath);

		setStatus('Searching for LaTeX files...');
		const texFiles: string[] = [];

		const findTexFiles = async (dir: string) => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await findTexFiles(fullPath);
				} else if (entry.name.endsWith('.tex')) {
					texFiles.push(fullPath);
				}
			}
		};

		if (await fs.pathExists(outputDir)) {
			await findTexFiles(outputDir);
		}

		if (texFiles.length === 0) {
			setStatus('No .tex files found to recompile.');
			return;
		}

		// Polishing is disabled as per user request

		setCompilations(
			texFiles.map((f) => ({ name: path.join(path.basename(path.dirname(f)), path.basename(f)), status: 'pending' }))
		);

		setStatus(`Polishing and Compiling ${texFiles.length} files...`);
		for (const texPath of texFiles) {
			const pdfDir = path.dirname(path.dirname(texPath));
			const pdfName = path.basename(pdfDir);
			const baseName = path.basename(texPath, '.tex');
			const displayLabel = `${pdfName}/${baseName}.docx`;

			// Clean before recompiling
			const originalContent = await fs.readFile(texPath, 'utf8');
			const initialClean = AssemblyService.cleanLatex(originalContent);

			// Prepend header programmatically - using path parts for context
			const header = AssemblyService.generateHeader(pdfName, baseName);
			await fs.writeFile(texPath, header + initialClean);

			const docxPath = path.join(pdfDir, `${baseName}.docx`);
			await compilerService.compile(texPath, docxPath);

			setCompilations((prev) =>
				prev.map((c) => (c.name === displayLabel ? { ...c, status: 'done' } : c))
			);
		}

		setStatus('Recompilation Success!');
	};

	const processPdfs = async () => {
		const tempDir = './temp';
		const templatePath = './files/template.docx';

		const stateService = new StateService(outputDir);
		await stateService.load();

		const pdfService = new PdfService(inputDir, tempDir);
		const compilerService = new CompilerService(templatePath);

		// Load system instructions
		const systemPrompt = await fs.readFile('./AGENT_PROMPT.md', 'utf-8');
		const aiService = new AiService(
			process.env['OPENROUTER_API_KEY'] || '',
			process.env['MODEL_NAME'] || 'google/gemini-2.5-flash',
			systemPrompt
		);

		const pdfFiles = (await fs.readdir(inputDir)).filter((f) => f.endsWith('.pdf') && !f.startsWith('_'));

		for (const pdfFile of pdfFiles) {
			const pdfPath = path.join(inputDir, pdfFile);
			setCurrentPdf(pdfFile);
			setStatus('Splitting PDF into images...');

			const imagePaths = await pdfService.convertToImages(pdfPath);
			setTotalPages(imagePaths.length);
			setStatus('Splitting PDF into images... [Done]');

			setStatus('Splitting PDF into subjects by boundary...');
			let rawChunks = await pdfService.splitByBoundary(imagePaths);

			// Preview chunks for inspection
			const previewDir = path.join(tempDir, 'preview');
			await fs.emptyDir(previewDir);
			for (const chunk of rawChunks) {
				const chunkDir = path.join(previewDir, `subject_${chunk.index}`);
				await fs.ensureDir(chunkDir);
				for (let i = 0; i < chunk.imagePaths.length; i++) {
					const imgPath = chunk.imagePaths[i]!;
					await fs.copy(imgPath, path.join(chunkDir, `${i + 1}_${path.basename(imgPath)}`));
				}
			}

			if (process.env['MAX_CHUNKS']) {
				rawChunks = rawChunks.slice(0, Number(process.env['MAX_CHUNKS']));
			}

			setChunks(
				rawChunks.map((c) => ({
					index: c.index,
					pages: `${c.pageNumbers[0]}-${c.pageNumbers[c.pageNumbers.length - 1]}`,
					progress: stateService.isChunkCompleted(pdfFile, c.index) ? 1 : 0,
					status: stateService.isChunkCompleted(pdfFile, c.index) ? 'done' : 'waiting',
				}))
			);

			const limit = pLimit(parseInt(process.env['CONCURRENCY_LIMIT'] || '5', 10));

			const chunkResults = await Promise.all(
				rawChunks.map((chunk) =>
					limit(async () => {
						if (stateService.isChunkCompleted(pdfFile, chunk.index)) {
							const cached: any = stateService.getCompletedChunks(pdfFile)[chunk.index]!;
							// If old schema (array of pages), convert it on the fly or just handle properly
							return cached.pages ? {
								detected_class: cached.pages[0]?.detected_class,
								detected_subject: cached.pages[0]?.detected_subject,
								latex_content: cached.pages.map((p: any) => p.latex_content).join('\n\n')
							} : cached;
						}

						setChunks((prev) =>
							prev.map((s) => (s.index === chunk.index ? { ...s, status: 'processing', progress: 0.1 } : s))
						);

						try {
							const result = await aiService.processChunk(chunk, {
								onProgress: (progress) => {
									setChunks((prev) =>
										prev.map((s) => (s.index === chunk.index ? { ...s, progress } : s))
									);
								},
								getCache: (p) => stateService.getValidImageUrl(pdfFile, p),
								setCache: (p, url) => stateService.saveUploadedImageUrl(pdfFile, p, url),
							});

							await stateService.saveChunkResult(pdfFile, chunk.index, result);

							setChunks((prev) =>
								prev.map((s) => (s.index === chunk.index ? { ...s, status: 'done', progress: 1 } : s))
							);

							return result;
						} catch (error) {
							setChunks((prev) =>
								prev.map((s) => (s.index === chunk.index ? { ...s, status: 'error' } : s))
							);
							throw error;
						}
					})
				)
			);

			const pdfBaseName = path.basename(pdfFile, '.pdf');
			const pdfOutputDir = path.join(outputDir, pdfBaseName);
			const texOutputDir = path.join(pdfOutputDir, 'tex');
			await fs.ensureDir(texOutputDir);

			const summaryEntries: { file: string; class: string; subject: string; firstQuestion: string }[] = [];

			for (let i = 0; i < rawChunks.length; i++) {
				const chunk = rawChunks[i]!;
				const result = chunkResults[i]!;

				const detectedClass = result.detected_class || 'UnknownClass';
				const detectedSubject = result.detected_subject || 'UnknownSubject';

				setDetections(prev => [...prev, `${detectedClass} - ${detectedSubject}`]);

				const sanitizedSubject = detectedSubject.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();
				const fileIndex = String(chunk.index).padStart(2, '0');
				const baseFileName = `${fileIndex}-${sanitizedSubject}`;

				setStatus(`Saving ${detectedSubject}...`);
				const cleanContent = AssemblyService.cleanLatex(result.latex_content);

				const texPath = path.join(texOutputDir, `${baseFileName}.tex`);
				const header = AssemblyService.generateHeader(detectedClass, detectedSubject);
				await fs.writeFile(texPath, header + cleanContent);

				const firstQuestion = AssemblyService.extractFirstQuestion(cleanContent);
				summaryEntries.push({
					file: `${baseFileName}.docx`,
					class: detectedClass,
					subject: detectedSubject,
					firstQuestion
				});

				setCompilations(prev => [...prev, { name: `${pdfBaseName}/${baseFileName}.docx`, status: 'pending' }]);

				setStatus(`Compiling ${detectedSubject} with Pandoc...`);
				// We want the .docx in the pdfOutputDir, not texOutputDir
				const docxPath = path.join(pdfOutputDir, `${baseFileName}.docx`);
				await compilerService.compile(texPath, docxPath);

				setCompilations((prev) =>
					prev.map((c) => (c.name === `${pdfBaseName}/${baseFileName}.docx` ? { ...c, status: 'done' } : c))
				);
			}

			// Generate SUMMARY.md
			const summaryPath = path.join(pdfOutputDir, 'SUMMARY.md');
			let summaryMd = `# Exam Subjects Found in: ${pdfFile}\n`;
			summaryMd += `This file helps you find which subject is in which Word document. You can press **Ctrl + F** to search for a subject name or first question.\n\n---\n\n`;

			for (const entry of summaryEntries) {
				summaryMd += `### 📄 File: ${entry.file}\n`;
				summaryMd += `- **Subject:** ${entry.subject}\n`;
				summaryMd += `- **Class:** ${entry.class}\n`;
				summaryMd += `- **First Question:** *"${entry.firstQuestion}"*\n\n`;
				summaryMd += `---\n\n`;
			}
			await fs.writeFile(summaryPath, summaryMd);

			// Update Master Summary
			const allPdfs = stateService.getPdfList();
			let masterMd = `# All Processed Exams Summary\n`;
			masterMd += `This is a master list of every subject extracted from every PDF. Use **Ctrl+F** to find what you need.\n\n`;

			for (const pName of allPdfs) {
				const pState = stateService.getPdfState(pName);
				masterMd += `## 📂 Source PDF: ${pName}\n\n`;

				const completed = pState.completedChunks || {};
				const sortedIdx = Object.keys(completed).sort((a, b) => Number(a) - Number(b));

				for (const idxString of sortedIdx) {
					const idx = Number(idxString);
					const chnk = completed[idx]!;
					const subj = chnk.detected_subject || 'Unknown';
					const clss = chnk.detected_class || 'Unknown';
					const sSubj = subj.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();
					const bName = `${String(idx).padStart(2, '0')}-${sSubj}.docx`;
					const fQ = AssemblyService.extractFirstQuestion(chnk.latex_content);

					masterMd += `### 📄 ${bName}\n`;
					masterMd += `- **Class:** ${clss}\n`;
					masterMd += `- **Subject:** ${subj}\n`;
					masterMd += `- **Question 1:** *"${fQ}"*\n\n`;
				}
				masterMd += `---\n\n`;
			}
			await fs.writeFile(path.join(outputDir, 'SUMMARY.md'), masterMd);
		}

		setStatus('Success!');
	};

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="cyan">=========================================================</Text>
			<Text bold color="cyan">                 E X A M O   v 2 . 0</Text>
			<Text bold color="cyan">=========================================================</Text>

			<Box flexDirection="column" marginY={1}>
				<Text bold>⚙️  Config:</Text>
				<Text>   Input Dir:  {inputDir}</Text>
				<Text>   Output Dir: {outputDir}</Text>
				<Text>   Model:      {process.env['MODEL_NAME'] || 'google/gemini-2.0-flash-001'}</Text>
			</Box>

			{!recompile && (
				<Box flexDirection="column" marginBottom={1}>
					<Text>📄 Processing: <Text color="yellow">{currentPdf}</Text> ({totalPages} pages)</Text>
					<Box>
						<Text>✂️  {status} </Text>
						{!status.includes('Done') && !status.includes('Success') && <Spinner />}
					</Box>
				</Box>
			)}

			{recompile && (
				<Box flexDirection="column" marginBottom={1}>
					<Box>
						<Text>🛠️  {status} </Text>
						{!status.includes('Success') && <Spinner />}
					</Box>
				</Box>
			)}

			{chunks.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>🚀 Concurrent Extraction Engine Running (Subject-based splitting):</Text>
					{chunks.map((chunk) => (
						<Box key={chunk.index}>
							<Text>   Chunk {chunk.index} (Pgs {chunk.pages}):   </Text>
							<Box width={30}>
								<ProgressBar value={chunk.progress} />
							</Box>
							<Text> {Math.floor(chunk.progress * 100)}% [{chunk.status === 'done' ? '✓' : chunk.status}]</Text>
						</Box>
					))}
				</Box>
			)}

			{detections.length > 0 && chunks.every(c => c.status === 'done') && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>🧠 Reassembling and stitching state...</Text>
					{detections.map((d, i) => (
						<Text key={i}>   ↳ {d}...</Text>
					))}
				</Box>
			)}

			{compilations.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text bold>📝 Compiling with Pandoc...</Text>
					{compilations.map((c, i) => (
						<Box key={i}>
							<Text>
								<Text color="green">   {c.name}</Text>
								{'      ['}
							</Text>
							{c.status === 'done' ? <Text>✓</Text> : <Spinner />}
							<Text>]</Text>
						</Box>
					))}
				</Box>
			)}

			{isFinished && (
				<Text bold color="green">✨ Task completed in {elapsedTime} seconds.</Text>
			)}
		</Box>
	);
}
