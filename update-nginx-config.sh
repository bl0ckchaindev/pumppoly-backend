#!/bin/bash

# Script to update nginx configuration for api.trollspump.fun
# This adds proper proxy headers and /uploads location block

echo "Backing up current nginx configuration..."
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.backup.$(date +%Y%m%d_%H%M%S)

echo "Updating nginx configuration..."

# Create the updated config
sudo tee /etc/nginx/sites-available/default > /dev/null << 'NGINX_CONFIG'
server {
    listen 80;
    server_name api.trollspump.fun;
    
    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.trollspump.fun;

    # SSL certificates (managed by Certbot)
    ssl_certificate /etc/letsencrypt/live/api.trollspump.fun/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.trollspump.fun/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Increase timeouts for large file uploads
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    send_timeout 60s;
    client_max_body_size 10M;

    # Backend API routes - proxy to Node.js backend
    location /api {
        proxy_pass http://127.0.0.1:3010/api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Requested-With' always;
        
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }

    # Backend uploads/images - CRITICAL: This must be configured for images to work
    location /uploads {
        proxy_pass http://127.0.0.1:3010/uploads;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # CORS headers for images
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Requested-With' always;
        add_header 'Cross-Origin-Resource-Policy' 'cross-origin' always;
        
        # Cache images for better performance
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, max-age=31536000" always;
        
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }

    # Health check endpoint
    location /health {
        proxy_pass http://127.0.0.1:3010/health;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Root and other routes - proxy to backend
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Requested-With' always;
        
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }
}

server {
    if ($host = api.trollspump.fun) {
        return 301 https://$host$request_uri;
    } # managed by Certbot

    server_name api.trollspump.fun;
    listen 80;
    return 404; # managed by Certbot
}
NGINX_CONFIG

echo ""
echo "Testing nginx configuration..."
if sudo nginx -t; then
    echo ""
    echo "✓ Nginx configuration is valid!"
    echo ""
    echo "Reloading nginx..."
    sudo systemctl reload nginx
    echo ""
    echo "✓ Nginx has been reloaded!"
    echo ""
    echo "You can now test the image URL:"
    echo "https://api.trollspump.fun/uploads/tokens/0x2a6e0d20d24ade9b98e678580f39c863bcdb781c-logo.png"
else
    echo ""
    echo "✗ Nginx configuration test failed!"
    echo "Restoring backup..."
    sudo cp /etc/nginx/sites-available/default.backup.* /etc/nginx/sites-available/default
    echo "Backup restored. Please check the configuration manually."
    exit 1
fi
