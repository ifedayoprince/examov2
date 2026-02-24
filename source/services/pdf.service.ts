import path from 'node:path';
import fs from 'fs-extra';
import { fromPath } from 'pdf2pic';

export interface Chunk {
    index: number;
    imagePaths: string[];
    pageNumbers: number[];
}

export class PdfService {
    private readonly tempDir: string;

    constructor(_inputDir: string, tempDir: string) {
        this.tempDir = tempDir;
    }

    async convertToImages(pdfPath: string): Promise<string[]> {
        const filename = path.basename(pdfPath, '.pdf');
        const outputDir = path.join(this.tempDir, filename);

        if (await fs.pathExists(outputDir)) {
            const files = await fs.readdir(outputDir);
            if (files.length > 0) {
                return files
                    .filter(f => f.endsWith('.png'))
                    .sort((a, b) => {
                        const numA = parseInt(a.match(/\d+/)?.[0] || '0');
                        const numB = parseInt(b.match(/\d+/)?.[0] || '0');
                        return numA - numB;
                    })
                    .map(f => path.join(outputDir, f));
            }
        }

        await fs.ensureDir(outputDir);

        const options = {
            density: 300,
            saveFilename: 'page',
            savePath: outputDir,
            format: 'png',
            width: 2480, // High res for Gemini vision
            height: 3508,
        };

        const convert = fromPath(pdfPath, options);
        const results = await convert.bulk(-1, { responseType: 'image' });

        return results.map((result) => result.path!);
    }

    chunkImages(imagePaths: string[], chunkSize: number): Chunk[] {
        const chunks: Chunk[] = [];
        for (let i = 0; i < imagePaths.length; i += chunkSize) {
            const slice = imagePaths.slice(i, i + chunkSize);
            chunks.push({
                index: Math.floor(i / chunkSize) + 1,
                imagePaths: slice,
                pageNumbers: slice.map((_, idx) => i + idx + 1),
            });
        }

        return chunks;
    }
}
