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

// Base name for token logo/banner files. The frontend sends the token address as the originalname
// (e.g. "0xabc….png" or a Solana mint), so files are named "<address>-logo.png" / "<address>-banner.png"
// and never collide across tokens that share a symbol. Strips path separators and the extension;
// keeps case (Solana base58 mints are case-sensitive; EVM 0x addresses arrive already lowercased).
function tokenFileBase(originalname) {
    const safe = String(originalname || '').replace(/[/\\]/g, '').replace(/\.\./g, '').trim();
    const base = safe.replace(/\.(png|jpe?g|webp|gif)$/i, '');
    return base || 'token';
}

// ── Token logo/banner upload security ────────────────────────────────────────────────────────────
// Logo and banner are validated server-side (type + size) and stored in src/uploads/tokens, named
// by token address: <address>-logo.png / <address>-banner.png (the frontend sends the token address
// as the file's originalname). Naming by address prevents two tokens with the same symbol from
// overwriting each other's images.
const LOGO_MAX_BYTES = 1 * 1024 * 1024;   // 1 MB
const BANNER_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

// Soft check on the client-declared mime (rejects SVG/GIF/non-images early). The authoritative check
// is detectImageType() on the actual bytes below — the client mime/extension is never trusted.
function imageMimeFilter(req, file, cb) {
    if (ALLOWED_IMAGE_MIMES.includes(String(file.mimetype || '').toLowerCase())) return cb(null, true);
    req.fileValidationError = 'Only PNG, JPG, JPEG, or WEBP images are allowed (no SVG or GIF).';
    return cb(null, false);
}

// Authoritative content-type check by magic bytes. Returns 'png' | 'jpeg' | 'webp', or null for
// anything else — GIF, SVG, and non-image files are rejected.
function detectImageType(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';   // \x89PNG
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';                      // JPEG SOI
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&                // "RIFF"
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp'; // "WEBP"
    return null;
}

// Run a multer middleware and turn its errors (e.g. file-too-large) into clean 4xx JSON.
function runUpload(mw) {
    return (req, res, next) => {
        mw(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ message: 'File too large' });
                return res.status(400).json({ message: err.message || 'Upload failed' });
            }
            next();
        });
    };
}

// Validate the in-memory upload (mime filter already ran; verify magic bytes + size) and persist it
// as <address>-<kind>.png. Rejects non-image / SVG / GIF payloads even if the client faked the mime.
function makeImageHandler(kind, maxBytes) {
    return (req, res) => {
        if (req.fileValidationError) return res.status(400).json({ message: req.fileValidationError });
        if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'No file was uploaded.' });
        if (req.file.size > maxBytes) return res.status(413).json({ message: 'File too large' });
        const type = detectImageType(req.file.buffer);
        if (!type) return res.status(400).json({ message: 'Invalid or unsupported image. Allowed: PNG, JPG, JPEG, WEBP.' });
        ensureUploadDir(TOKENS_UPLOAD_DIR);
        const filename = tokenFileBase(req.file.originalname) + '-' + kind + '.png';
        try {
            fs.writeFileSync(path.join(TOKENS_UPLOAD_DIR, filename), req.file.buffer);
        } catch (e) {
            console.error('Failed to write upload:', e.message);
            return res.status(500).json({ message: 'Failed to save file' });
        }
        return res.status(200).json({
            fileInfo: { filename, originalname: req.file.originalname, mimetype: 'image/' + type, size: req.file.size }
        });
    };
}

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

const logoUpload = multer({ storage: multer.memoryStorage(), fileFilter: imageMimeFilter, limits: { fileSize: LOGO_MAX_BYTES } });
const bannerUpload = multer({ storage: multer.memoryStorage(), fileFilter: imageMimeFilter, limits: { fileSize: BANNER_MAX_BYTES } });
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

router.post('/uploads/logo', uploadLimiter, runUpload(logoUpload.single('file')), makeImageHandler('logo', LOGO_MAX_BYTES));

router.post('/uploads/banner', uploadLimiter, runUpload(bannerUpload.single('file')), makeImageHandler('banner', BANNER_MAX_BYTES));

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
router.post('/logoUploads', uploadLimiter, runUpload(logoUpload.single('file')), makeImageHandler('logo', LOGO_MAX_BYTES));

router.post('/bannerUploads', uploadLimiter, runUpload(bannerUpload.single('file')), makeImageHandler('banner', BANNER_MAX_BYTES));

router.post('/profileUploads', uploadLimiter, profileUpload.single('file'), (req, res) => {
    if (req.file) {
        return res.status(200).json({ fileInfo: req.file });
    } else {
        res.status(400).json({ message: 'No file was uploaded.' });
    }
});

module.exports = router;

