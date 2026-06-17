import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import dotenv from 'dotenv';
import App from './app.js';

dotenv.config();

const cli = meow(
	`
	Usage
	  $ examov2

	Options
		--input, -i       Input directory containing PDFs (default: ./input)
		--output, -o      Output directory for DOCX files (default: ./output)
		--recompile, -r   Recompile all existing .tex files in output directory
		--path, -p        Path to a specific .tex file to recompile
		--rebuild, -b     Reconstruct .tex and .docx files from offline saved state JSON file

	Examples
	  $ examov2 --input=./exam_pdfs --output=./processed
	  $ examov2 --recompile
	  $ examov2 --rebuild
`,
	{
		importMeta: import.meta,
		flags: {
			input: {
				type: 'string',
				alias: 'i',
				default: './input',
			},
			output: {
				type: 'string',
				alias: 'o',
				default: './output',
			},
			recompile: {
				type: 'boolean',
				alias: 'r',
				default: false,
			},
			path: {
				type: 'string',
				alias: 'p',
			},
			rebuild: {
				type: 'boolean',
				alias: 'b',
				default: false,
			},
		},
	},
);

render(<App 
	inputDir={cli.flags.input}
	outputDir={cli.flags.output} recompile={cli.flags.recompile} texPath={cli.flags.path} rebuild={cli.flags.rebuild} />);
