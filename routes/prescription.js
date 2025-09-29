const express = require('express');
const router = express.Router();
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configure multer for file storage in a temporary 'uploads/' directory
// This will be created inside your 'node' folder.
const upload = multer({ dest: 'uploads/' });

// POST /api/prescriptions/parse
router.post('/parse', upload.single('prescription'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'No prescription image file uploaded.' });
    }

    // --- THE DEFINITIVE FIX: Convert the relative image path to an absolute path ---
    // This resolves 'uploads/xyz' to '/home/adi/.../node/uploads/xyz'
    const imagePath = path.resolve(req.file.path);

    const pythonDir = path.join(__dirname, '..', 'python');
    const pythonScriptPath = path.join(pythonDir, 'prescription_parser.py');
    const pythonExecutable = path.join(pythonDir, 'venv', 'Scripts', 'python.exe');

    console.log(`[Server] Image saved to ABSOLUTE path: ${imagePath}`); // New log for confirmation
    console.log(`[Server] Python directory is: ${pythonDir}`);

    if (!fs.existsSync(pythonExecutable)) {
        fs.unlinkSync(imagePath);
        console.error(`[Server] Error: Python virtual environment executable not found at ${pythonExecutable}.`);
        return res.status(500).json({ success: false, message: "Server configuration error." });
    }

    // Run the script from within the 'python' directory
    const pythonProcess = spawn(pythonExecutable, [pythonScriptPath, imagePath], { cwd: pythonDir });

    let jsonData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        jsonData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        // Don't log expected debug messages as errors
        if (!data.toString().startsWith('[Python] Received arguments:')) {
            console.error(`[Python Script Error] ${data}`);
        }
    });

    pythonProcess.on('close', (code) => {
        fs.unlink(imagePath, (err) => {
            if (err) console.error(`[Server] Error deleting temp file ${imagePath}:`, err);
        });

        if (code === 0) {
            try {
                const parsedJson = JSON.parse(jsonData);
                console.log('[Server] Successfully parsed prescription.');
                res.status(200).json(parsedJson);
            } catch (e) {
                console.error("[Server] Failed to parse JSON from Python. Raw output:", jsonData);
                res.status(500).json({ success: false, message: 'Failed to parse script output.' });
            }
        } else {
            console.error(`[Server] Python script exited with error code ${code}.`);
            res.status(500).json({ success: false, message: "The prescription parser failed.", details: errorData });
        }
    });
});

module.exports = router;

