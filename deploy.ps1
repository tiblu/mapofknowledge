$key = "$PSScriptRoot\mapofknowledge.pub"
ssh -i $key virt147958@217.146.69.48 "cd ~/domeenid/www.themapofknowledge.com/knobits && git pull origin knobitmap && npm install --production && pm2 update && pm2 reload knobitmap-server --update-env && echo 'Deploy complete'"
