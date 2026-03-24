const { body, param, query, validationResult } = require('express-validator');

// Validation middleware
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ 
            message: 'Validation failed',
            errors: errors.array() 
        });
    }
    next();
};

// Token creation validation
const validateTokenCreation = [
    body('tokenAddress')
        .notEmpty().withMessage('Token address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('bondingCurveAddress')
        .notEmpty().withMessage('Bonding curve address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('creator')
        .notEmpty().withMessage('Creator address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('name')
        .notEmpty().withMessage('Token name is required')
        .isLength({ min: 1, max: 100 }).withMessage('Name must be between 1 and 100 characters')
        .trim(),
    body('symbol')
        .notEmpty().withMessage('Token symbol is required')
        .isLength({ min: 1, max: 20 }).withMessage('Symbol must be between 1 and 20 characters')
        .trim(),
    body('transactionHash')
        .notEmpty().withMessage('Transaction hash is required')
        .matches(/^0x[a-fA-F0-9]{64}$/).withMessage('Invalid transaction hash'),
    body('blockNumber')
        .notEmpty().withMessage('Block number is required')
        .isInt({ min: 0 }).withMessage('Block number must be a positive integer'),
    body('timestamp')
        .notEmpty().withMessage('Timestamp is required')
        .isInt({ min: 0 }).withMessage('Timestamp must be a positive integer'),
    body('imageUrl').optional().isURL().withMessage('Invalid image URL'),
    body('website').optional().isURL().withMessage('Invalid website URL'),
    body('twitter').optional().isURL().withMessage('Invalid Twitter URL'),
    body('telegram').optional().isURL().withMessage('Invalid Telegram URL'),
    body('discord').optional().isURL().withMessage('Invalid Discord URL'),
    validate
];

// Address validation
const validateAddress = [
    param('tokenAddress')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    validate
];

const validateBondingCurveAddress = [
    param('bondingCurveAddress')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    validate
];

// Chat/comment validation
const validateChat = [
    body('ShitlordAddress')
        .notEmpty().withMessage('Token address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('sender')
        .notEmpty().withMessage('Sender address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('content')
        .notEmpty().withMessage('Content is required')
        .isLength({ min: 1, max: 1000 }).withMessage('Content must be between 1 and 1000 characters')
        .trim(),
    body('timestamp')
        .notEmpty().withMessage('Timestamp is required')
        .isString().withMessage('Timestamp must be a string'),
    body('imageUrl').optional().isURL().withMessage('Invalid image URL'),
    validate
];

// Profile validation
const validateProfile = [
    body('profileAddress')
        .notEmpty().withMessage('Profile address is required')
        .isEthereumAddress().withMessage('Invalid Ethereum address'),
    body('name')
        .notEmpty().withMessage('Name is required')
        .isLength({ min: 1, max: 100 }).withMessage('Name must be between 1 and 100 characters')
        .trim(),
    body('telegram').optional().isURL().withMessage('Invalid Telegram URL'),
    body('twitter').optional().isURL().withMessage('Invalid Twitter URL'),
    body('website').optional().isURL().withMessage('Invalid website URL'),
    validate
];

// Query parameter validation
const validatePagination = [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1 }).withMessage('Limit must be a positive integer'),
    validate
];

module.exports = {
    validate,
    validateTokenCreation,
    validateAddress,
    validateBondingCurveAddress,
    validateChat,
    validateProfile,
    validatePagination
};

