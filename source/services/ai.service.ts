import fs from 'fs-extra';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { Chunk } from './pdf.service.js';

const aiResultSchema = z.object({
    detected_class: z.string().nullable(),
    detected_subject: z.string().nullable(),
    latex_content: z.string(),
});

export type AiResult = z.infer<typeof aiResultSchema>;

export class AiService {
    private readonly openai;
    private readonly modelName: string;
    private readonly systemPrompt: string;

    constructor(apiKey: string, modelName: string, systemPrompt: string) {
        this.openai = createOpenAI({
            apiKey,
            baseURL: 'https://openrouter.ai/api/v1',
        });
        this.modelName = modelName;
        this.systemPrompt = systemPrompt;
    }

    async processBatch(
        chunks: Chunk[],
        options?: {
            onProgress?: (chunkIndex: number, progress: number) => void;
            getCache?: (filePath: string) => string | null;
            setCache?: (filePath: string, url: string) => Promise<void>;
        }
    ): Promise<AiResult[]> {
        const chunksImageUrls: string[][] = [];

        for (const chunk of chunks) {
            const imageUrls: string[] = [];

            for (let i = 0; i < chunk.imagePaths.length; i++) {
                const p = chunk.imagePaths[i]!;

                // Check cache first
                const cachedUrl = options?.getCache?.(p);
                if (cachedUrl) {
                    imageUrls.push(cachedUrl);
                    if (options?.onProgress) {
                        options.onProgress(chunk.index, 0.1 + ((i + 1) / chunk.imagePaths.length) * 0.6);
                    }
                    continue;
                }

                const buffer = await fs.readFile(p);
                let uploaded = false;
                let lastError: any = null;
                let downloadUrl = '';

                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const formData = new FormData();
                        const blob = new Blob([buffer as any], { type: 'image/png' });
                        formData.append('file', blob, `page_${chunk.pageNumbers[i]}.png`);

                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120s timeout

                        const response = await fetch('https://tmpfiles.org/api/v1/upload', {
                            method: 'POST',
                            body: formData,
                            signal: controller.signal,
                        });

                        clearTimeout(timeoutId);

                        const json = (await response.json()) as any;
                        if (json.status === 'success' && json.data?.url) {
                            downloadUrl = json.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                            uploaded = true;
                            break;
                        } else {
                            throw new Error(`Upload failed: ${JSON.stringify(json)}`);
                        }
                    } catch (error: any) {
                        lastError = error;
                        // Wait a bit before retry
                        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                    }
                }

                if (!uploaded) {
                    throw new Error(`Failed to upload ${p} after 3 attempts. Last error: ${lastError?.message}`);
                }

                await options?.setCache?.(p, downloadUrl);
                imageUrls.push(downloadUrl);

                if (options?.onProgress) {
                    options.onProgress(chunk.index, 0.1 + ((i + 1) / chunk.imagePaths.length) * 0.6);
                }
            }
            chunksImageUrls.push(imageUrls);
        }

        for (const chunk of chunks) {
            if (options?.onProgress) {
                options.onProgress(chunk.index, 0.75); // Starting AI processing
            }
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 min timeout for batch AI

        const contentParts: any[] = [];
        let imgIdx = 0;
        let textInstruction = `You are processing a batch of ${chunks.length} distinct exam(s) from a single PDF document.\n`;
        textInstruction += `Here is the list of exams and their corresponding images:\n`;

        chunks.forEach((chunk, chunkIdx) => {
            const numImages = chunk.imagePaths.length;
            textInstruction += `- Exam #${chunkIdx + 1}: The next ${numImages} image(s) (Image #${imgIdx + 1} to Image #${imgIdx + numImages})\n`;
            imgIdx += numImages;
        });

        textInstruction += `\nFor EACH exam, you must transcribe the handwritten draft into LaTeX following the rules of formatting, typo handling, and structure.
IMPORTANT: You MUST wrap each exam's output in the following tag format:
<exam_latex class="[detected_class_here]" subject="[detected_subject_here]">
[LaTeX content here]
</exam_latex>

Make sure to output exactly ${chunks.length} <exam_latex> tag blocks in the exact order specified. Do not output anything else outside of these tags. Do not wrap the whole response in JSON.`;

        contentParts.push({
            type: 'text',
            text: textInstruction,
        });

        for (const imageUrls of chunksImageUrls) {
            for (const url of imageUrls) {
                contentParts.push({
                    type: 'image' as const,
                    image: new URL(url),
                });
            }
        }

        try {
            const { text } = await generateText({
                model: this.openai(this.modelName),
                system: this.systemPrompt,
                abortSignal: controller.signal,
                messages: [
                    {
                        role: 'user',
                        content: contentParts,
                    },
                ],
            });

            const results: AiResult[] = [];
            const tagRegex = /<exam_latex([^>]*)>([\s\S]*?)<\/exam_latex>/gi;
            let match;

            while ((match = tagRegex.exec(text)) !== null) {
                const attrString = match[1] || '';
                const content = match[2] || '';

                const classMatch = attrString.match(/class=["']([^"']*)["']/i);
                const subjectMatch = attrString.match(/subject=["']([^"']*)["']/i);

                const detected_class = classMatch && classMatch[1] ? classMatch[1].trim() : null;
                const detected_subject = subjectMatch && subjectMatch[1] ? subjectMatch[1].trim() : null;

                results.push({
                    detected_class: detected_class || null,
                    detected_subject: detected_subject || null,
                    latex_content: content.trim(),
                });
            }

            if (results.length !== chunks.length) {
                throw new Error(`Expected ${chunks.length} results from batch processing, but parsed ${results.length}. Response: ${text}`);
            }

            return results;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
