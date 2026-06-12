import path from 'node:path';
import fs from 'fs-extra';
import { fromPath } from 'pdf2pic';
import sharp from 'sharp';

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
        };

        const convert = fromPath(pdfPath, options);
        const results = await convert.bulk(-1, { responseType: 'image' });

        return results.map((result) => result.path!);
    }

    async isBoundaryPage(imagePath: string): Promise<boolean> {
        try {
            const { channels } = await sharp(imagePath).stats();
            // Average mean across R, G, B channels
            const mean = channels.reduce((acc, c) => acc + c.mean, 0) / channels.length;
            
            // Average standard deviation across channels
            const stddev = channels.reduce((acc, c) => acc + c.stdev, 0) / channels.length;

            // A plain white page will have high brightness (mean > 200) 
            // and very low variance/stddev (standard deviation < 30)
            // Lighting might vary, so these values are heuristic but generally safe for "plain white paper"
            return mean > 200 && stddev < 30;
        } catch (error) {
            console.error(`Error analyzing image ${imagePath}:`, error);
            return false;
        }
    }

    async splitByBoundary(imagePaths: string[]): Promise<Chunk[]> {
        const chunks: Chunk[] = [];
        let currentImagePaths: string[] = [];
        let currentPageNumbers: number[] = [];
        let chunkIndex = 1;

        for (let i = 0; i < imagePaths.length; i++) {
            const path = imagePaths[i]!;
            const isBoundary = await this.isBoundaryPage(path);

            if (isBoundary) {
                chunks.push({
                    index: chunkIndex++,
                    imagePaths: [path, ...currentImagePaths],
                    pageNumbers: [i + 1, ...currentPageNumbers],
                });
                currentImagePaths = [];
                currentPageNumbers = [];
            } else {
                currentImagePaths.push(path);
                currentPageNumbers.push(i + 1);
            }
        }

        // Push final chunk if any
        if (currentImagePaths.length > 0) {
            chunks.push({
                index: chunkIndex,
                imagePaths: currentImagePaths,
                pageNumbers: currentPageNumbers,
            });
        }

        return chunks;
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
