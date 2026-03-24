const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const { uploadLimiter, validateFilePath } = require('../middleware/security');

// Absolute paths for uploads (relative to this file so they work regardless of cwd)
const UPLOADS_BASE = path.join(__dirname, '..', 'uploads');
const PROFILE_UPLOAD_DIR = path.join(UPLOADS_BASE, 'profile');
const TOKENS_UPLOAD_DIR = path.join(UPLOADS_BASE, 'tokens');
const COMMENTS_UPLOAD_DIR = path.join(UPLOADS_BASE, 'comments');

function ensureUploadDir(dir) {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (err) {
        console.error('Failed to create upload directory:', dir, err.message);
    }
}
[UPLOADS_BASE, PROFILE_UPLOAD_DIR, TOKENS_UPLOAD_DIR, COMMENTS_UPLOAD_DIR].forEach(ensureUploadDir);

// Helper function to find file case-insensitively
function findFileCaseInsensitive(dir, fileName) {
    try {
        const files = fs.readdirSync(dir);
        // First try exact match
        if (files.includes(fileName)) {
            return path.join(dir, fileName);
        }
        // Then try case-insensitive match
        const foundFile = files.find(file => file.toLowerCase() === fileName.toLowerCase());
        if (foundFile) {
            return path.join(dir, foundFile);
        }
        return null;
    } catch (error) {
        return null;
    }
}

// Sanitize profile filename: EVM (0x...) -> lowercase; Solana (base58) -> as-is. No path separators.
function sanitizeProfileFilename(name) {
    if (!name || typeof name !== 'string') return 'unknown';
    const safe = name.replace(/[/\\..]/g, '').trim();
    if (!safe) return 'unknown';
    return safe.startsWith('0x') ? safe.toLowerCase() : safe;
}

// File upload configuration
const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        ensureUploadDir(TOKENS_UPLOAD_DIR);
        cb(null, TOKENS_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname + "-" + 'logo' + ".png");
    },
});

const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        ensureUploadDir(UPLOADS_BASE);
        cb(null, UPLOADS_BASE);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname + "-" + 'banner' + ".png");
    },
});

const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        ensureUploadDir(PROFILE_UPLOAD_DIR);
        cb(null, PROFILE_UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const base = sanitizeProfileFilename(file.originalname);
        const baseNoExt = base.replace(/\.(png|jpe?g)$/i, '') || base;
        cb(null, baseNoExt + '.png');
    },
});

const logoUpload = multer({ storage: logoStorage });
const bannerUpload = multer({ storage: bannerStorage });
const profileUpload = multer({
    storage: profileStorage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            req.fileValidationError = 'Only image files are allowed for profile avatar.';
            cb(new Error(req.fileValidationError), false);
        }
    },
    limits: { fileSize: 2 * 1024 * 1024 } // 2MB for profile avatar
});

// Comment/chat image upload storage
const commentImageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "src/uploads/comments/");
    },
    filename: (req, file, cb) => {
        // Generate unique filename with timestamp
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = file.originalname.split('.').pop();
        cb(null, 'comment-' + uniqueSuffix + '.' + ext);
    },
});

// File filter for images only
const imageFilter = (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        req.fileValidationError = 'Only image files are allowed!';
        cb(new Error('Only image files are allowed!'), false);
    }
};

const commentImageUpload = multer({ 
    storage: commentImageStorage,
    fileFilter: imageFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Upload routes with rate limiting
// Note: Specific routes (profile, comments) must be defined before generic route

router.post('/uploads/logo', uploadLimiter, logoUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

router.post('/uploads/banner', uploadLimiter, bannerUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

router.post('/uploads/profile', uploadLimiter, profileUpload.single('file'), (req, res) => {
    if (req.fileValidationError) {
        return res.status(400).json({ message: req.fileValidationError });
    }
    if (req.file) {
        return res.status(200).json({
            fileInfo: req.file,
            filename: req.file.filename,
            message: 'Profile avatar uploaded successfully'
        });
    }
    res.status(400).json({ message: 'No file was uploaded.' });
});

// Comment image upload
router.post('/uploads/comment', uploadLimiter, commentImageUpload.single('image'), (req, res) => {
    // Handle multer errors
    if (req.fileValidationError) {
        return res.status(400).json({ message: req.fileValidationError });
    }
    
    if (req.file) {
        // Return the file path that can be used to access the image
        const imageUrl = `/uploads/comments/${req.file.filename}`;
        return res.status(200).json({ 
            message: 'Image uploaded successfully',
            imageUrl: imageUrl,
            fileInfo: {
                filename: req.file.filename,
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            }
        });
    } else {
        res.status(400).json({ message: 'No image file was uploaded.' });
    }
});

// Serve comment images
router.get('/uploads/comments/:name', (req, res) => {
    try {
        const fileName = req.params.name;
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ message: 'Invalid filename' });
        }
        const filePath = path.join(COMMENTS_UPLOAD_DIR, fileName);
        const validatedPath = validateFilePath(filePath);
        // Set CORS headers for image serving
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.sendFile(validatedPath);
    } catch (error) {
        res.status(400).json({ message: 'Invalid file path' });
    }
});

// Serve profile images
router.get('/uploads/profile/:name', (req, res) => {
    try {
        let fileName = req.params.name;
        // Validate filename to prevent path traversal
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ message: 'Invalid filename' });
        }
        if (!fileName.toLowerCase().endsWith('.png')) {
            fileName = fileName + '.png';
        }
        const profileDir = PROFILE_UPLOAD_DIR;
        const foundFilePath = findFileCaseInsensitive(profileDir, fileName);
        
        if (!foundFilePath) {
            return res.status(404).json({ message: 'File not found' });
        }
        
        const validatedPath = validateFilePath(foundFilePath);
        // Set CORS headers for image serving
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(validatedPath);
    } catch (error) {
        res.status(400).json({ message: 'Invalid file path' });
    }
});

// Serve token logos
router.get('/uploads/tokens/:name', (req, res) => {
    try {
        const fileName = req.params.name;
        // Validate filename to prevent path traversal
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ message: 'Invalid filename' });
        }
        
        const tokensDir = TOKENS_UPLOAD_DIR;
        const foundFilePath = findFileCaseInsensitive(tokensDir, fileName);
        
        if (!foundFilePath) {
            return res.status(404).json({ message: 'File not found' });
        }
        
        const validatedPath = validateFilePath(foundFilePath);
        // Set CORS headers for image serving
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Content-Type', 'image/png');
        res.sendFile(validatedPath);
    } catch (error) {
        res.status(400).json({ message: 'Invalid file path' });
    }
});

// Generic upload route (must be after specific routes like /profile, /tokens, and /comments)
router.get('/uploads/:name', (req, res) => {
    try {
        const fileName = req.params.name;
        // Validate filename to prevent path traversal
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ message: 'Invalid filename' });
        }
        
        const uploadsDir = UPLOADS_BASE;
        const foundFilePath = findFileCaseInsensitive(uploadsDir, fileName);
        
        if (!foundFilePath) {
            return res.status(404).json({ message: 'File not found' });
        }
        
        const validatedPath = validateFilePath(foundFilePath);
        // Set CORS headers for image serving
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.sendFile(validatedPath);
    } catch (error) {
        res.status(400).json({ message: 'Invalid file path' });
    }
});

// Legacy upload routes (for backward compatibility with frontend)
router.post('/logoUploads', uploadLimiter, logoUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

router.post('/bannerUploads', uploadLimiter, bannerUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

router.post('/profileUploads', uploadLimiter, profileUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

module.exports = router;

