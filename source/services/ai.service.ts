import fs from 'fs-extra';
import { generateText, Output } from 'ai';
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

    async processChunk(
        chunk: Chunk,
        options?: {
            onProgress?: (progress: number) => void;
            getCache?: (filePath: string) => string | null;
            setCache?: (filePath: string, url: string) => Promise<void>;
        }
    ): Promise<AiResult> {
        const imageUrls: string[] = [];

        for (let i = 0; i < chunk.imagePaths.length; i++) {
            const p = chunk.imagePaths[i]!;

            // Check cache first
            const cachedUrl = options?.getCache?.(p);
            if (cachedUrl) {
                imageUrls.push(cachedUrl);
                if (options?.onProgress) {
                    options.onProgress(0.1 + ((i + 1) / chunk.imagePaths.length) * 0.6);
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
                // Uploading takes up 0.1 to 0.7 of the chunk's progress
                options.onProgress(0.1 + ((i + 1) / chunk.imagePaths.length) * 0.6);
            }
        }

        if (options?.onProgress) {
            options.onProgress(0.75); // Starting AI processing
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 min timeout for AI

        try {
            const { output } = await generateText({
                model: this.openai(this.modelName),
                system: this.systemPrompt,
                abortSignal: controller.signal,
                output: Output.object({
                    schema: aiResultSchema,
                }),
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `Process these scanned handwritten images as a single complete exam. Extract the text into LaTeX following the system instructions.`,
                            },
                            ...imageUrls.map((url) => ({
                                type: 'image' as const,
                                image: new URL(url),
                            })),
                        ],
                    },
                ],
            });
            return output;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async polishLatex(content: string): Promise<string> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout

        try {
            const { text } = await generateText({
                model: this.openai(this.modelName),
                system: `You are a LaTeX formatting expert. Your task is to polish the provided LaTeX code of an exam paper. 
Strictly follow these rules:
1. Every section (e.g., SECTION A) must contain exactly ONE parent \\begin{enumerate} block. 
2. Merge any split questions where the text is in one item and options are in another.
3. Remove all \\setcounter{enumi}{...} lines and [resume] options from enumerate environments.
4. Ensure every question is punctuated properly.
5. MANDATORY: Every option in an enumerate bucket must start with a CAPITAL letter.
6. Return ONLY the polished LaTeX code. NO markdown code blocks, NO preamble, NO comments.`,
                abortSignal: controller.signal,
                messages: [
                    {
                        role: 'user',
                        content: `Please polish this LaTeX exam content. Ensure it is one continuous list per section:\n\n${content}`,
                    },
                ],
            });
            return text;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
