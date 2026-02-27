// @ts-ignore
import pandoc from 'node-pandoc';

export class CompilerService {
    private readonly templatePath: string;

    constructor(templatePath: string) {
        this.templatePath = templatePath;
    }

    async compile(texPath: string, outputPath?: string): Promise<string> {
        const docxPath = outputPath || texPath.replace('.tex', '.docx');
        const args = [
            '-f',
            'latex',
            '-t',
            'docx',
            '--reference-doc',
            this.templatePath,
            '-o',
            docxPath,
        ];

        return new Promise((resolve, reject) => {
            pandoc(texPath, args, (err: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(docxPath);
                }
            });
        });
    }
}
