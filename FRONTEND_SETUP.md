# Frontend Backend Integration Guide

Since your frontend is deployed at `trollspump.fun` and backend needs to be accessible, here are the setup options:

## Option 1: Nginx Reverse Proxy (Recommended)

This allows your frontend to call `https://trollspump.fun/api` and it will automatically proxy to the backend.

### Step 1: Create Nginx Configuration

Create/edit `/etc/nginx/sites-available/trollspump.fun`:

```nginx
server {
    listen 80;
    server_name trollspump.fun www.trollspump.fun;

    # Serve frontend static files
    root /path/to/your/frontend/build;
    index index.html;

    # Frontend routes (React/Vue/etc.)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Backend API - reverse proxy to Node.js backend
    location /api {
        proxy_pass http://localhost:3010/api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # CORS headers (if needed)
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, PATCH, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization, X-Requested-With' always;
        
        if ($request_method = 'OPTIONS') {
            return 204;
        }
    }

    # Health check
    location /health {
        proxy_pass http://localhost:3010/health;
    }
}
```

### Step 2: Enable and Reload Nginx

```bash
# Link the config
sudo ln -s /etc/nginx/sites-available/trollspump.fun /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### Step 3: Configure Frontend API URL

In your frontend code, set the API base URL to:

```javascript
// Production - uses same domain
const API_URL = process.env.REACT_APP_API_URL || '/api';

// Or explicitly
const API_URL = 'https://trollspump.fun/api';
```

## Option 2: Direct Port Access (Not Recommended for Production)

If you don't want to use nginx reverse proxy, frontend can connect directly to port 3010.

### Configure Frontend API URL

```javascript
// Direct connection to backend port
const API_URL = 'http://trollspump.fun:3010/api';

// Or using environment variable
const API_URL = process.env.REACT_APP_API_URL || 'http://trollspump.fun:3010/api';
```

**Note:** This requires:
- Opening port 3010 in firewall
- Using HTTP (not HTTPS unless backend has SSL)
- Browser may block mixed content (HTTP on HTTPS site)

## Option 3: Backend on Subdomain (Alternative)

You can serve backend at `api.trollspump.fun`:

### Nginx Configuration for Subdomain

```nginx
# Frontend
server {
    listen 80;
    server_name trollspump.fun www.trollspump.fun;
    
    root /path/to/frontend/build;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
}

# Backend API subdomain
server {
    listen 80;
    server_name api.trollspump.fun;
    
    location / {
        proxy_pass http://localhost:3010;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Frontend Configuration

```javascript
const API_URL = 'https://api.trollspump.fun/api';
```

## Current Backend Configuration

Your backend is configured to:
- ✅ Listen on `0.0.0.0:3010` (all network interfaces)
- ✅ CORS enabled for all origins
- ✅ API routes at `/api/*`

## Testing

### Test Backend Directly

```bash
# Test backend health check
curl http://localhost:3010/health

# Test API endpoint
curl http://localhost:3010/api/tokens
```

### Test from Frontend Domain

```bash
# With nginx reverse proxy (Option 1)
curl http://trollspump.fun/health
curl http://trollspump.fun/api/tokens

# Direct port access (Option 2)
curl http://trollspump.fun:3010/health
curl http://trollspump.fun:3010/api/tokens

# Subdomain (Option 3)
curl http://api.trollspump.fun/health
curl http://api.trollspump.fun/api/tokens
```

## Common Issues

### Issue: "Failed to fetch" or CORS errors

**Solution:**
1. Make sure backend is running: `pm2 status` or `ps aux | grep node`
2. Check backend is listening: `sudo netstat -tlnp | grep 3010`
3. Test backend directly: `curl http://localhost:3010/health`
4. Check nginx configuration if using reverse proxy
5. Verify frontend API URL is correct

### Issue: 502 Bad Gateway

**Solution:**
1. Backend not running - restart: `pm2 restart your-backend-name`
2. Wrong proxy_pass URL in nginx - should be `http://localhost:3010`
3. Backend crashed - check logs: `pm2 logs`

### Issue: Mixed Content (HTTP/HTTPS)

**Solution:**
- Use nginx reverse proxy with SSL certificate (Let's Encrypt)
- Both frontend and backend should use HTTPS
- Or set API_URL to use HTTPS if backend has SSL

## Recommended Setup

**Best practice for production:**

1. ✅ Use nginx reverse proxy (Option 1)
2. ✅ Setup SSL certificate for HTTPS
3. ✅ Frontend API URL: `/api` (relative URL)
4. ✅ Backend listens on `localhost:3010` (internal only)
5. ✅ Use PM2 to manage backend process

## Quick Setup Commands

```bash
# 1. Make sure backend is running
cd /path/to/backend
pm2 start src/index.js --name backend
pm2 save

# 2. Test backend
curl http://localhost:3010/health

# 3. Configure nginx (edit the file above)

# 4. Test nginx config
sudo nginx -t

# 5. Reload nginx
sudo systemctl reload nginx

# 6. Test from domain
curl http://trollspump.fun/health
curl http://trollspump.fun/api/tokens
```

## Frontend Environment Variables

Create `.env` in your frontend project:

```env
# Option 1: Relative URL (with nginx reverse proxy)
REACT_APP_API_URL=/api

# Option 2: Full URL (direct port access)
# REACT_APP_API_URL=http://trollspump.fun:3010/api

# Option 3: Subdomain
# REACT_APP_API_URL=https://api.trollspump.fun/api
```

Then in your frontend code:

```javascript
const API_BASE_URL = process.env.REACT_APP_API_URL || '/api';

// Use in fetch calls
fetch(`${API_BASE_URL}/tokens`)
  .then(res => res.json())
  .then(data => console.log(data));
```
