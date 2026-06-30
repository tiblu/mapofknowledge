$key = "$PSScriptRoot\knobitz.pub"
$dir = "~/domeenid/www.knobitz.com/htdocs"

ssh -i $key virt149225@knobitz.com "cd $dir && git pull origin knobitmap && npm install --omit=dev && pm2 reload knobitz-server --update-env && echo 'Deploy complete'"
