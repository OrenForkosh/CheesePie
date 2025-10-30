TrueNAS SCALE install (simplest)

Prereqs
- TrueNAS SCALE 25.04.x
- Dataset path for the app: `/mnt/cheese/general/services/cheesepie`

Steps
1) Copy/clone this repo into `/mnt/cheese/general/services/cheesepie` on your NAS.

2) In TrueNAS UI → Apps → Add Docker Compose → Import from file:
   - Select `/mnt/cheese/general/services/cheesepie/docker-compose.truenas.yml`

3) Accept defaults. Optionally add environment variables:
   - `GIT_REPO` and `GIT_BRANCH` to auto-pull latest code on container start.

4) Deploy. The app will:
   - Install `git` + `ffmpeg` in the container
   - (Optionally) pull latest code from GitHub
   - `pip install -r requirements.txt`
   - Serve at `http://<truenas-ip>:8000`

Update
- With `GIT_REPO` set: Stop → Start the app to pull latest.
- Without it: SSH to NAS → `cd /mnt/cheese/general/services/cheesepie && git pull`, then restart the app if deps changed.

Notes
- The container runs from the bind-mounted folder, so edits on the NAS reflect immediately.
- ffmpeg is installed in the container for encoding.
