# Goat cam snapshots (Raspberry Pi 5)

Every 30 minutes the Pi takes a picture from the Tapo C200, checks it for people on the Pi itself,
and publishes it only if no person is found. Rejected pictures are deleted straight away.
Nothing is sent to a cloud service.

## 1. Camera

1. In the Tapo app, open the camera settings, go to **Advanced Settings → Camera Account**, and create an account
   with its own username and password (not your Tapo login).
2. In your router, give the camera a fixed IP address, for example `192.168.1.50`.
3. Check the stream on a computer on your home network with VLC (`Media → Open Network Stream`):
   `rtsp://CAMERA_ACCOUNT:CAMERA_PASSWORD@192.168.1.50:554/stream2`.

## 2. Pi software

```bash
sudo apt update
sudo apt install -y ffmpeg python3-venv
sudo useradd --system --create-home goatcam
sudo mkdir -p /opt/goat-cam /var/www/goat-cam /var/lib/goat-cam
sudo chown goatcam:goatcam /var/www/goat-cam /var/lib/goat-cam
sudo python3 -m venv /opt/goat-cam/venv
sudo /opt/goat-cam/venv/bin/pip install ultralytics opencv-python-headless
```

Copy the detector weights (`yolov8n.pt`, a small model that is fast on a Pi). Download it on any computer from
https://github.com/ultralytics/assets/releases and copy it to `/opt/goat-cam/yolov8n.pt`.

## 3. Install the snapshot job

```bash
sudo cp cam/snapshot.py /opt/goat-cam/snapshot.py
sudo cp cam/goat-cam.env.example /etc/goat-cam.env
sudo nano /etc/goat-cam.env          # fill in the camera password and any settings
sudo chmod 600 /etc/goat-cam.env
sudo cp cam/goat-cam.service cam/goat-cam.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now goat-cam.timer
```

Test it once by hand, and check the log:

```bash
sudo systemctl start goat-cam.service
journalctl -u goat-cam.service -n 20
```

The log says either `published snapshot` or `person found, not published`. It never includes the camera password.
Check `/var/www/goat-cam/` for `latest.jpg` and `meta.json`.

## 4. Make it public through a Cloudflare Tunnel

The Pi runs a small web server that only serves the photo files, and `cloudflared` connects that server to
a public address. No port is opened on your router. You need a domain (or subdomain) managed by Cloudflare,
for example `cam.yourdomain.example`.

**a. Install the web server.**

```bash
sudo cp cam/serve.py /opt/goat-cam/serve.py
sudo cp cam/goat-cam-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now goat-cam-web.service
curl -sI http://127.0.0.1:8080/meta.json      # should show "200 OK"
```

**b. Install cloudflared** (the Raspberry Pi 5 uses the arm64 package):

```bash
curl -fsSL -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo apt install -y ./cloudflared.deb
cloudflared --version
```

**c. Create the tunnel.** Run these on the Pi. The first one opens a link to sign in to Cloudflare in a browser
and asks for the domain to use.

```bash
cloudflared tunnel login
cloudflared tunnel create goat-cam
cloudflared tunnel route dns goat-cam cam.yourdomain.example
```

`tunnel create` prints a tunnel ID and writes a credentials file to `~/.cloudflared/<ID>.json`.

**d. Write the tunnel config** at `/etc/cloudflared/config.yml`, using your tunnel ID and the hostname:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: /etc/cloudflared/<TUNNEL-ID>.json
ingress:
  - hostname: cam.yourdomain.example
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Copy the credentials file to `/etc/cloudflared/` as well, then install the service:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/
sudo cloudflared service install
sudo systemctl status cloudflared
```

The last line must be the only public route. Do not add any other hostnames to this config, so nothing else
on the Pi is reachable from the internet.

**e. Check it from outside your home network** (for example on a phone using mobile data):

```bash
curl -sI https://cam.yourdomain.example/meta.json     # "200 OK" and "Access-Control-Allow-Origin: *"
```

Then set `CAM_URL` in `index.html` to `"https://cam.yourdomain.example/"` and push. The goat cam page will
show the newest photo and the time it was taken.

**Troubleshooting**
- Error 502 or 1033 from Cloudflare: the tunnel is up but `goat-cam-web` is not running. Check
  `systemctl status goat-cam-web`.
- The page shows the placeholder but the URL works: the browser console will say if the request was blocked,
  usually because `CAM_URL` has no trailing slash or does not match the hostname exactly.

## Settings

- `CAM_PERSON_THRESHOLD` (default `0.25`): lower blocks more frames. Keep it low.
- `CAM_QUIET_HOURS` (set to `22-6`): no snapshots from 22:00 to 06:00 local time. Change it or leave it empty to change this.

## Limits

No detector is perfect. It can miss someone partly out of view, far away, in the dark or turned away.
If a person stands in view for a long time, the page keeps the last clear photo and shows its time.
