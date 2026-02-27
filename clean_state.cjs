const fs = require('fs-extra');
const path = require('path');

const statePath = path.join(__dirname, 'output', '.examo_state.json');

async function clean() {
    if (!(await fs.pathExists(statePath))) {
        console.log('No state file found.');
        return;
    }

    const state = await fs.readJson(statePath);
    let fixedCount = 0;

    for (const pdfName in state.pdfs) {
        const completed = state.pdfs[pdfName].completedChunks;
        for (const index in completed) {
            let content = completed[index].latex_content;
            if (content.endsWith('"}')) {
                console.log(`Cleaning garbage from ${pdfName} chunk ${index}`);
                completed[index].latex_content = content.slice(0, -2).trim();
                fixedCount++;
            }
        }
    }

    if (fixedCount > 0) {
        await fs.writeJson(statePath, state, { spaces: 2 });
        console.log(`Cleaned ${fixedCount} chunks.`);
    } else {
        console.log('No garbage found in state file.');
    }
}

clean().catch(console.error);
