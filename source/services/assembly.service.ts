export interface FinalDocument {
    class: string;
    subject: string;
    texPath: string;
}

export class AssemblyService {
    constructor(_: string) { }

    public static cleanLatex(content: string): string {
        return content
            // 1. Remove all comments (lines starting with %)
            .replace(/^%.*$/gm, '')
            // 2. Remove any \setcounter{enumi}{...} lines, even with leading spaces
            .replace(/^\s*\\setcounter\{enumi\}\{\d+\}.*$/gm, '')
            // 3. Merge adjacent enumerate environments that split across pages
            // This replaces \end{enumerate} [whitespace] \begin{enumerate} with just whitespace
            .replace(/\\end\{enumerate\}\s*\\begin\{enumerate\}(\[resume\])?/g, '\n')
            // 4. Remove any remaining [resume] from enumerate environments
            .replace(/\\begin\{enumerate\}\[resume\]/g, '\\begin{enumerate}')
            // 5. Clean up multiple newlines resulting from replacements
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    public static generateHeader(cls: string, subj: string): string {
        const displaySubj = (subj || 'Unknown Subject').replace(/_/g, ' ');
        const displayCls = (cls || 'Unknown Class').replace(/_/g, ' ');

        return [
            '\\begin{flushleft}\\textbf{NAME: ____________________________}\\end{flushleft}',
            `\\begin{flushleft}\\textbf{\\uppercase{SUBJECT: ${displaySubj}}}\\end{flushleft}`,
            `\\begin{flushleft}\\textbf{\\uppercase{CLASS: ${displayCls}}}\\end{flushleft}`,
            '\\begin{flushleft}\\textbf{DATE: ____________________________}\\end{flushleft}',
            '',
            ''
        ].join('\n');
    }

    public static extractFirstQuestion(latex: string): string {
        // Look for the first \item that isn't just a nested list opener
        // This is a naive but effective way to get the gist of the first question
        const match = latex.match(/\\item\s+([^\\{[]+)/);
        if (match && match[1]) {
            return match[1].trim().substring(0, 100) + (match[1].trim().length > 100 ? '...' : '');
        }
        return 'No question text detected.';
    }
}
