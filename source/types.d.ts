declare module 'ink-progress-bar' {
    import { FC } from 'react';
    interface Props {
        value?: number;
        character?: string;
        percent?: number;
        left?: number;
        right?: number;
    }
    const ProgressBar: FC<Props>;
    export default ProgressBar;
}

declare module 'node-pandoc' {
    function pandoc(src: string, args: string[], callback: (err: any, result?: string) => void): void;
    export default pandoc;
}
