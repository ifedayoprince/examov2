import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Spinner, ProgressBar } from '@inkjs/ui';
import fs from 'fs-extra';
import path from 'node:path';
import { AssemblyService } from './services/assembly.service.js';
import { CompilerService } from './services/compiler.service.js';
import { ProcessorService, ChunkStatus } from './services/processor.service.js';

type Props = {
	inputDir: string;
	outputDir: string;
	recompile?: boolean;
	texPath?: string;
	rebuild?: boolean;
};

export default function App({ inputDir, outputDir, recompile, texPath, rebuild }: Props) {
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

		const task = rebuild ? rebuildFromState() : (recompile || texPath) ? recompileAll(texPath) : processPdfs();

		task.then(() => {
			setIsFinished(true);
			clearInterval(interval);
		});

		return () => clearInterval(interval);
	}, []);

	const rebuildFromState = async () => {
		const templatePath = './files/template.docx';
		const compilerService = new CompilerService(templatePath);

		setStatus('Reading state file...');

		const stateFilePath = path.join(outputDir, '.examo_state.json');
		if (!(await fs.pathExists(stateFilePath))) {
			setStatus(`Error: No state file found at ${stateFilePath}`);
			return;
		}

		let state: any;
		try {
			state = await fs.readJson(stateFilePath);
		} catch {
			setStatus('Error: Failed to parse state file.');
			return;
		}

		const pdfNames: string[] = Object.keys(state.pdfs || {});
		if (pdfNames.length === 0) {
			setStatus('No PDFs found in state file.');
			return;
		}

		for (const pdfName of pdfNames) {
			const pdfState = state.pdfs[pdfName];
			const completedChunks: Record<string, any> = pdfState?.completedChunks || {};
			const sortedIndices = Object.keys(completedChunks).sort((a, b) => Number(a) - Number(b));

			if (sortedIndices.length === 0) continue;

			const pdfBaseName = path.basename(pdfName, '.pdf');
			const pdfOutputDir = path.join(outputDir, pdfBaseName);
			const texOutputDir = path.join(pdfOutputDir, 'tex');
			await fs.ensureDir(texOutputDir);

			for (const idxStr of sortedIndices) {
				const idx = Number(idxStr);
				const raw: any = completedChunks[idx];

				// Support both old flat shape and new batched shape
				let detectedClass: string;
				let detectedSubject: string;
				let latexContent: string;

				if (raw.pages) {
					detectedClass = raw.pages[0]?.detected_class || 'UnknownClass';
					detectedSubject = raw.pages[0]?.detected_subject || 'UnknownSubject';
					latexContent = raw.pages.map((p: any) => p.latex_content).join('\n\n');
				} else {
					detectedClass = raw.detected_class || 'UnknownClass';
					detectedSubject = raw.detected_subject || 'UnknownSubject';
					latexContent = raw.latex_content || '';
				}

				const sanitizedSubject = detectedSubject.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').trim();
				const fileIndex = String(idx).padStart(2, '0');
				const baseFileName = `${fileIndex}-${sanitizedSubject}`;

				setStatus(`Rebuilding ${detectedSubject} (${detectedClass})...`);

				const cleanContent = AssemblyService.cleanLatex(latexContent);
				const header = AssemblyService.generateHeader(detectedClass, detectedSubject);
				const texFilePath = path.join(texOutputDir, `${baseFileName}.tex`);
				await fs.writeFile(texFilePath, header + cleanContent);

				const compilationLabel = `${pdfBaseName}/${baseFileName}.docx`;
				setCompilations((prev) => [...prev, { name: compilationLabel, status: 'pending' }]);

				const docxPath = path.join(pdfOutputDir, `${baseFileName}.docx`);
				await compilerService.compile(texFilePath, docxPath);

				setCompilations((prev) =>
					prev.map((c) => (c.name === compilationLabel ? { ...c, status: 'done' } : c))
				);
			}
		}

		setStatus('Rebuild from state complete!');
	};

	const recompileAll = async (specificPath?: string) => {
		const templatePath = './files/template.docx';
		const compilerService = new CompilerService(templatePath);

		setStatus('Searching for LaTeX files...');
		let texFiles: string[] = [];

		if (specificPath) {
			if (await fs.pathExists(specificPath)) {
				texFiles = [specificPath];
			} else {
				setStatus(`Error: File not found at ${specificPath}`);
				return;
			}
		} else {
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
		}

		if (texFiles.length === 0) {
			setStatus('No .tex files found to recompile.');
			return;
		}
		
		setCompilations(
			texFiles.map((f) => {
				const pdfDir = path.dirname(path.dirname(f));
				const pdfName = path.basename(pdfDir);
				const baseName = path.basename(f, '.tex');
				return { name: `${pdfName}/${baseName}.docx`, status: 'pending' };
			})
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
		const processor = new ProcessorService(inputDir, outputDir, {
			onPdfStart: (pdfFile) => setCurrentPdf(pdfFile),
			onStatusChange: (statusText) => setStatus(statusText),
			onTotalPagesChange: (pages) => setTotalPages(pages),
			onChunksChange: (chunkList) => setChunks(chunkList),
			onChunkProgress: (index, progress, chunkStatus) => {
				setChunks((prev) =>
					prev.map((s) => (s.index === index ? { ...s, progress, status: chunkStatus } : s))
				);
			},
			onDetectionAdded: (detection) => {
				setDetections((prev) => [...prev, detection]);
			},
			onCompilationAdded: (c) => {
				setCompilations((prev) => [...prev, c]);
			},
			onCompilationUpdated: (name, compilationStatus) => {
				setCompilations((prev) =>
					prev.map((c) => (c.name === name ? { ...c, status: compilationStatus } : c))
				);
			},
		});

		await processor.process();
	};

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="cyan">=========================================================</Text>
			<Text bold color="cyan">                 E X A M O   v 3 . 0</Text>
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

			{(recompile || rebuild) && (
				<Box flexDirection="column" marginBottom={1}>
					<Box>
						<Text>{rebuild ? '🔁' : '🛠️'}  {status} </Text>
						{!status.includes('Success') && !status.includes('complete') && !status.includes('Error') && <Spinner />}
					</Box>
				</Box>
			)}

			{chunks.length > 0 && (() => {
				// Group chunks by batch number
				const batchGroups = chunks.reduce<Record<number, typeof chunks>>((acc, chunk) => {
					const key = chunk.batch ?? 1;
					if (!acc[key]) acc[key] = [];
					acc[key]!.push(chunk);
					return acc;
				}, {});
				const batchKeys = Object.keys(batchGroups).map(Number).sort((a, b) => a - b);

				return (
					<Box flexDirection="column" marginBottom={1}>
						<Text bold>🚀 Concurrent Extraction Engine Running (Subject-based splitting):</Text>
						{batchKeys.map((batchNum) => {
							const batchChunks = batchGroups[batchNum]!;
							const allDone = batchChunks.every((c) => c.status === 'done');
							const anyProcessing = batchChunks.some((c) => c.status === 'processing');
							return (
								<Box key={batchNum} flexDirection="column">
									<Text color="yellow">
										{'   '}📦 Batch {batchNum}{' '}
										{allDone ? <Text color="green">[✓ sent]</Text> : anyProcessing ? <Text color="cyan">[sending...]</Text> : <Text color="gray">[queued]</Text>}
									</Text>
									{batchChunks.map((chunk) => (
										<Box key={chunk.index}>
											<Text>      Chunk {chunk.index} (Pgs {chunk.pages}):   </Text>
											<Box width={30}>
												<ProgressBar value={chunk.progress} />
											</Box>
											<Text> {Math.floor(chunk.progress * 100)}% [{chunk.status === 'done' ? '✓' : chunk.status}]</Text>
										</Box>
									))}
								</Box>
							);
						})}
					</Box>
				);
			})()}

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
