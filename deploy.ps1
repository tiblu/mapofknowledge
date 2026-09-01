$key = "$PSScriptRoot\mapofknowledge_deploy"
ssh -i $key virt147958@217.146.69.48 "cd ~/domeenid/www.themapofknowledge.com/htdocs && git pull origin prod && npm install --production && pm2 update && pm2 reload mok-server --update-env && echo 'Deploy complete'"
