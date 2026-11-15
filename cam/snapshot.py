#!/usr/bin/env python3
"""Goat cam snapshot: capture a frame, check it for people, publish it only if the check is clear.

Runs on the home machine (Raspberry Pi) every 30 minutes, see goat-cam.timer.
The frame is checked on the Pi and never sent anywhere else. Frames with a person
in them, and frames that fail any check, are deleted and not published.

Settings are read from environment variables, see goat-cam.env.example.
"""
import datetime as dt
import json
import logging
import os
import pathlib
import subprocess
import sys

RTSP_URL = os.environ.get("CAM_RTSP_URL", "")          # rtsp://account:password@camera-ip:554/stream2
PUBLISH_DIR = pathlib.Path(os.environ.get("CAM_PUBLISH_DIR", "/var/www/goat-cam"))
WORK_DIR = pathlib.Path(os.environ.get("CAM_WORK_DIR", "/var/lib/goat-cam"))
MODEL_PATH = os.environ.get("CAM_MODEL", "/opt/goat-cam/yolov8n.pt")
# Low on purpose: a missed person is worse than a skipped photo.
PERSON_THRESHOLD = float(os.environ.get("CAM_PERSON_THRESHOLD", "0.25"))
PERSON_CLASS = 0                                        # "person" in the COCO classes used by YOLO
# Local hours with no snapshots, e.g. "22-6". Empty means take snapshots all day.
QUIET_HOURS = os.environ.get("CAM_QUIET_HOURS", "")

log = logging.getLogger("goat-cam")


def in_quiet_hours(now: dt.datetime) -> bool:
    if not QUIET_HOURS:
        return False
    start, end = (int(x) for x in QUIET_HOURS.split("-"))
    hour = now.hour
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end                  # window wraps past midnight


def capture(target: pathlib.Path) -> bool:
    """Grab one frame from the camera into target. Returns False if it failed."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    if RTSP_URL.startswith("rtsp://"):
        cmd += ["-rtsp_transport", "tcp"]
    cmd += ["-i", RTSP_URL, "-frames:v", "1", str(target)]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        log.error("capture timed out")
        return False
    if result.returncode != 0 or not target.exists() or target.stat().st_size == 0:
        # ffmpeg's error text can include the camera URL, so only report the exit code
        log.error("capture failed (ffmpeg exit %s)", result.returncode)
        return False
    return True


def person_count(image: pathlib.Path) -> int:
    """Number of people found in the image. Raises if the check itself fails."""
    from ultralytics import YOLO  # imported here so the rest works without the model installed

    model = YOLO(MODEL_PATH)
    results = model.predict(str(image), classes=[PERSON_CLASS], conf=PERSON_THRESHOLD, verbose=False)
    return len(results[0].boxes)


def publish(image: pathlib.Path, taken: dt.datetime) -> None:
    """Move the checked frame into the public folder in one step, so visitors never see a partial file."""
    PUBLISH_DIR.mkdir(parents=True, exist_ok=True)
    tmp_image = PUBLISH_DIR / "latest.jpg.tmp"
    tmp_image.write_bytes(image.read_bytes())
    os.replace(tmp_image, PUBLISH_DIR / "latest.jpg")

    tmp_meta = PUBLISH_DIR / "meta.json.tmp"
    tmp_meta.write_text(json.dumps({"taken": taken.isoformat(timespec="minutes")}))
    os.replace(tmp_meta, PUBLISH_DIR / "meta.json")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not RTSP_URL:
        log.error("CAM_RTSP_URL is not set")
        return 2

    now = dt.datetime.now().astimezone()
    if in_quiet_hours(now):
        log.info("quiet hours, no snapshot")
        return 0

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    candidate = WORK_DIR / "candidate.jpg"
    try:
        if not capture(candidate):
            return 1
        try:
            people = person_count(candidate)
        except Exception as exc:                        # fail closed: if the check breaks, nothing is published
            log.error("person check failed (%s), not published", type(exc).__name__)
            return 1
        if people > 0:
            log.info("person found, not published")
            return 0
        publish(candidate, now)
        log.info("published snapshot")
        return 0
    finally:
        candidate.unlink(missing_ok=True)               # rejected or not, the frame is not kept


if __name__ == "__main__":
    sys.exit(main())
