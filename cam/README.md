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

## 4. Make it public through the Cloudflare Tunnel

Use `cloudflared` on the Pi, with a public hostname such as `cam.yourdomain.example`, pointing at
`http://localhost:8080`. Serve `/var/www/goat-cam` on port 8080, for example with
`python3 -m http.server 8080 --directory /var/www/goat-cam` as a service, or with Caddy or nginx.
Do not forward any port on the router.

Then set `CAM_URL` in `index.html` to `"https://cam.yourdomain.example/"` and push. The goat cam page will
show the newest photo and the time it was taken.

## Settings

- `CAM_PERSON_THRESHOLD` (default `0.25`): lower blocks more frames. Keep it low.
- `CAM_QUIET_HOURS` (for example `22-6`): no snapshots during those local hours.

## Limits

No detector is perfect. It can miss someone partly out of view, far away, in the dark or turned away.
If a person stands in view for a long time, the page keeps the last clear photo and shows its time.
