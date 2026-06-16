import sharp from 'sharp';
import path from 'node:path';
import fs from 'fs-extra';

/**
 * Test script to check if an image is detected as a boundary (white page).
 * Usage: node test-boundary.js <path-to-image>
 */

async function testBoundary(imagePath) {
    if (!imagePath) {
        console.error('Error: Please provide a path to an image file.');
        process.exit(1);
    }

    if (!fs.existsSync(imagePath)) {
        console.error(`Error: File not found at ${imagePath}`);
        process.exit(1);
    }

    console.log(`Analyzing: ${path.basename(imagePath)}...`);

    try {
        const { channels } = await sharp(imagePath).stats();
        
        // Average mean across R, G, B channels
        const mean = channels.reduce((acc, c) => acc + c.mean, 0) / channels.length;
        
        // Average standard deviation across channels
        const stddev = channels.reduce((acc, c) => acc + c.stdev, 0) / channels.length;

        console.log('--- Results ---');
        console.log(`Mean Brightness: ${mean.toFixed(2)} (Threshold: > 200)`);
        console.log(`Standard Deviation: ${stddev.toFixed(2)} (Threshold: < 25)`);
        console.log('---------------');

        const isBoundary = mean > 200 && stddev < 25;

        if (isBoundary) {
            console.log('✅ Result: BOUNDARY DETECTED (Plain white/blank page)');
        } else {
            console.log('❌ Result: NOT A BOUNDARY (Content page or poor lighting)');
        }
    } catch (error) {
        console.error('Error during analysis:', error);
    }
}

const args = process.argv.slice(2);
testBoundary(args[0]);
