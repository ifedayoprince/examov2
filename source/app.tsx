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

		// Load system instructions for AI polishing
		const systemPrompt = await fs.readFile('./AGENT_PROMPT.md', 'utf-8');
		const aiService = new AiService(
			process.env['OPENROUTER_API_KEY'] || '',
			process.env['MODEL_NAME'] || 'google/gemini-2.5-flash',
			systemPrompt
		);

		setCompilations(
			texFiles.map((f) => ({ name: path.join(path.basename(path.dirname(f)), path.basename(f)), status: 'pending' }))
		);

		setStatus(`Polishing and Compiling ${texFiles.length} files...`);
		for (const texPath of texFiles) {
			const fileName = path.join(path.basename(path.dirname(texPath)), path.basename(texPath));

			// Clean and Polish before recompiling
			const originalContent = await fs.readFile(texPath, 'utf8');
			const initialClean = AssemblyService.cleanLatex(originalContent);
			const polished = await aiService.polishLatex(initialClean);

			// Prepend header programmatically
			const header = AssemblyService.generateHeader(path.basename(path.dirname(texPath)), path.basename(texPath, '.tex'));
			await fs.writeFile(texPath, header + polished);

			await compilerService.compile(texPath);
			setCompilations((prev) =>
				prev.map((c) => (c.name === fileName ? { ...c, status: 'done' } : c))
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
		const assemblyService = new AssemblyService(outputDir);
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

			const chunkSize = parseInt(process.env['CHUNK_SIZE'] || '10', 10);
			let rawChunks = pdfService.chunkImages(imagePaths, chunkSize);

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
							return stateService.getCompletedChunks(pdfFile)[chunk.index]!;
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

			// Extract all detections after all chunks are processed
			const allDetections = chunkResults
				.flatMap(result => result.pages)
				.map(p => (p.detected_class && p.detected_subject ? `Detected ${p.detected_class} - ${p.detected_subject}` : null))
				.filter((d): d is string => d !== null);

			setDetections(prev => Array.from(new Set([...prev, ...allDetections])));

			setStatus('Reassembling and stitching state...');
			const finalDocs = await assemblyService.assemble(chunkResults);

			setStatus('Polishing LaTeX with AI...');
			for (const doc of finalDocs) {
				const content = await fs.readFile(doc.texPath, 'utf8');
				const polished = await aiService.polishLatex(content);

				// Prepend header programmatically
				const header = AssemblyService.generateHeader(doc.class, doc.subject);
				await fs.writeFile(doc.texPath, header + polished);
			}

			setCompilations(finalDocs.map((d) => ({ name: `${d.class}_${d.subject}.docx`, status: 'pending' })));

			setStatus('Compiling with Pandoc...');
			for (const doc of finalDocs) {
				await compilerService.compile(doc.texPath);
				setCompilations((prev) =>
					prev.map((c) => (c.name === `${doc.class}_${doc.subject}.docx` ? { ...c, status: 'done' } : c))
				);
			}
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
					<Text bold>🚀 Concurrent Extraction Engine Running ({process.env['CHUNK_SIZE'] || '10'} pages/chunk):</Text>
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
