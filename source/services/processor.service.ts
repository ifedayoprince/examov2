import fs from 'fs-extra';
import path from 'node:path';
import pLimit from 'p-limit';
import { PdfService, type Chunk } from './pdf.service.js';
import { AiService, type AiResult } from './ai.service.js';
import { AssemblyService } from './assembly.service.js';
import { CompilerService } from './compiler.service.js';
import { StateService } from './state.service.js';

export interface ChunkStatus {
	index: number;
	pages: string;
	progress: number;
	status: 'waiting' | 'processing' | 'done' | 'error';
	batch?: number;
}

export interface ProcessorCallbacks {
	onPdfStart?: (pdfFile: string) => void;
	onStatusChange?: (status: string) => void;
	onTotalPagesChange?: (totalPages: number) => void;
	onChunksChange?: (chunks: ChunkStatus[]) => void;
	onChunkProgress?: (index: number, progress: number, status: 'waiting' | 'processing' | 'done' | 'error') => void;
	onDetectionAdded?: (detection: string) => void;
	onCompilationAdded?: (c: { name: string; status: 'done' | 'pending' }) => void;
	onCompilationUpdated?: (name: string, status: 'done' | 'pending') => void;
}

export class ProcessorService {
	private readonly inputDir: string;
	private readonly outputDir: string;
	private readonly callbacks: ProcessorCallbacks;

	constructor(inputDir: string, outputDir: string, callbacks: ProcessorCallbacks) {
		this.inputDir = inputDir;
		this.outputDir = outputDir;
		this.callbacks = callbacks;
	}

	async process(): Promise<void> {
		const tempDir = './temp';
		const templatePath = './files/template.docx';

		const stateService = new StateService(this.outputDir);
		await stateService.load();

		const pdfService = new PdfService(this.inputDir, tempDir);
		const compilerService = new CompilerService(templatePath);

		// Load system instructions
		const systemPrompt = await fs.readFile('./AGENT_PROMPT.md', 'utf-8');
		const aiService = new AiService(
			process.env['OPENROUTER_API_KEY'] || '',
			process.env['MODEL_NAME'] || 'google/gemini-2.5-flash',
			systemPrompt
		);

		const pdfFiles = (await fs.readdir(this.inputDir)).filter((f) => f.endsWith('.pdf') && !f.startsWith('_'));

		for (const pdfFile of pdfFiles) {
			const pdfPath = path.join(this.inputDir, pdfFile);
			this.callbacks.onPdfStart?.(pdfFile);
			this.callbacks.onStatusChange?.('Splitting PDF into images...');

			const imagePaths = await pdfService.convertToImages(pdfPath);
			this.callbacks.onTotalPagesChange?.(imagePaths.length);
			this.callbacks.onStatusChange?.('Splitting PDF into images... [Done]');

			this.callbacks.onStatusChange?.('Splitting PDF into subjects by boundary...');
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

			if (process.env['TEST_EXAMS']) {
				const testIndices = process.env['TEST_EXAMS'].split(',').map((s) => Number(s.trim()));
				rawChunks = rawChunks.filter((c) => testIndices.includes(c.index));
			}

			const batchSize = Number(process.env['BATCH_SIZE'] || '3');

			this.callbacks.onChunksChange?.(
				rawChunks.map((c, idx) => ({
					index: c.index,
					pages: `${Math.min(...c.pageNumbers)}-${Math.max(...c.pageNumbers)}`,
					progress: stateService.isChunkCompleted(pdfFile, c.index) ? 1 : 0,
					status: stateService.isChunkCompleted(pdfFile, c.index) ? 'done' : 'waiting',
					batch: Math.floor(idx / batchSize) + 1,
				}))
			);

			const pendingChunks = rawChunks.filter((c) => !stateService.isChunkCompleted(pdfFile, c.index));

			// Group pending chunks into batches
			const chunkBatches: Chunk[][] = [];
			for (let i = 0; i < pendingChunks.length; i += batchSize) {
				chunkBatches.push(pendingChunks.slice(i, i + batchSize));
			}

			const batchLimit = pLimit(parseInt(process.env['BATCH_CONCURRENCY_LIMIT'] || '1', 10));

			await Promise.all(
				chunkBatches.map((batch) =>
					batchLimit(async () => {
						for (const chunk of batch) {
							this.callbacks.onChunkProgress?.(chunk.index, 0.1, 'processing');
						}

						try {
							const results = await aiService.processBatch(batch, {
								onProgress: (chunkIndex, progress) => {
									this.callbacks.onChunkProgress?.(chunkIndex, progress, 'processing');
								},
								getCache: (p) => stateService.getValidImageUrl(pdfFile, p),
								setCache: (p, url) => stateService.saveUploadedImageUrl(pdfFile, p, url),
							});

							for (let i = 0; i < batch.length; i++) {
								const chunk = batch[i]!;
								const result = results[i]!;

								await stateService.saveChunkResult(pdfFile, chunk.index, result);
								this.callbacks.onChunkProgress?.(chunk.index, 1, 'done');
							}
						} catch (error) {
							for (const chunk of batch) {
								this.callbacks.onChunkProgress?.(chunk.index, 0, 'error');
							}
							throw error;
						}
					})
				)
			);

			// Retrieve all chunk results (either from stateService if previously cached/completed, or newly completed)
			const chunkResults: AiResult[] = [];
			for (let i = 0; i < rawChunks.length; i++) {
				const chunk = rawChunks[i]!;
				const cached: any = stateService.getCompletedChunks(pdfFile)[chunk.index]!;
				const result = cached.pages ? {
					detected_class: cached.pages[0]?.detected_class,
					detected_subject: cached.pages[0]?.detected_subject,
					latex_content: cached.pages.map((p: any) => p.latex_content).join('\n\n')
				} : cached;
				chunkResults.push(result);
			}

			const pdfBaseName = path.basename(pdfFile, '.pdf');
			const pdfOutputDir = path.join(this.outputDir, pdfBaseName);
			const texOutputDir = path.join(pdfOutputDir, 'tex');
			await fs.ensureDir(texOutputDir);

			const summaryEntries: { file: string; class: string; subject: string; firstQuestion: string }[] = [];

			for (let i = 0; i < rawChunks.length; i++) {
				const chunk = rawChunks[i]!;
				const result = chunkResults[i]!;

				const detectedClass = result.detected_class || 'UnknownClass';
				const detectedSubject = result.detected_subject || 'UnknownSubject';

				this.callbacks.onDetectionAdded?.(`${detectedClass} - ${detectedSubject}`);

				const sanitizedSubject = detectedSubject.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();
				const fileIndex = String(chunk.index).padStart(2, '0');
				const baseFileName = `${fileIndex}-${sanitizedSubject}`;

				this.callbacks.onStatusChange?.(`Saving ${detectedSubject}...`);
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

				const compilationLabel = `${pdfBaseName}/${baseFileName}.docx`;
				this.callbacks.onCompilationAdded?.({ name: compilationLabel, status: 'pending' });

				this.callbacks.onStatusChange?.(`Compiling ${detectedSubject} with Pandoc...`);
				// We want the .docx in the pdfOutputDir, not texOutputDir
				const docxPath = path.join(pdfOutputDir, `${baseFileName}.docx`);
				await compilerService.compile(texPath, docxPath);

				this.callbacks.onCompilationUpdated?.(compilationLabel, 'done');
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
			await fs.writeFile(path.join(this.outputDir, 'SUMMARY.md'), masterMd);
		}

		this.callbacks.onStatusChange?.('Success!');
	}
}
