import fs from 'fs-extra';
import path from 'node:path';
import type { AiResult } from './ai.service.js';

export interface ChunkState {
    index: number;
    result: AiResult;
}

export interface PdfState {
    completedChunks: { [index: number]: AiResult };
    uploadedImages: { [path: string]: { url: string; timestamp: number } };
}

export interface AppState {
    pdfs: { [pdfName: string]: PdfState };
}

export class StateService {
    private readonly stateFilePath: string;
    private state: AppState = { pdfs: {} };

    constructor(outputDir: string) {
        this.stateFilePath = path.join(outputDir, '.examo_state.json');
    }

    async load(): Promise<void> {
        if (await fs.pathExists(this.stateFilePath)) {
            try {
                this.state = await fs.readJson(this.stateFilePath);
            } catch (error) {
                console.error('Failed to load state file, starting fresh:', error);
                this.state = { pdfs: {} };
            }
        }
    }

    async save(): Promise<void> {
        await fs.writeJson(this.stateFilePath, this.state, { spaces: 2 });
    }

    getPdfState(pdfName: string): PdfState {
        if (!this.state.pdfs[pdfName]) {
            this.state.pdfs[pdfName] = { completedChunks: {}, uploadedImages: {} };
        }
        return this.state.pdfs[pdfName]!;
    }

    async saveChunkResult(pdfName: string, chunkIndex: number, result: AiResult): Promise<void> {
        const pdfState = this.getPdfState(pdfName);
        pdfState.completedChunks[chunkIndex] = result;
        await this.save();
    }

    async saveUploadedImageUrl(pdfName: string, filePath: string, url: string): Promise<void> {
        const pdfState = this.getPdfState(pdfName);
        pdfState.uploadedImages[filePath] = { url, timestamp: Date.now() };
        await this.save();
    }

    getValidImageUrl(pdfName: string, filePath: string): string | null {
        const imageState = this.getPdfState(pdfName).uploadedImages[filePath];
        if (!imageState) return null;

        const sixtyMinutesMs = 60 * 60 * 1000;
        if (Date.now() - imageState.timestamp < sixtyMinutesMs) {
            return imageState.url;
        }

        return null; // Expired
    }

    getCompletedChunks(pdfName: string): { [index: number]: AiResult } {
        return this.getPdfState(pdfName).completedChunks;
    }

    isChunkCompleted(pdfName: string, chunkIndex: number): boolean {
        return !!this.getPdfState(pdfName).completedChunks[chunkIndex];
    }
}
