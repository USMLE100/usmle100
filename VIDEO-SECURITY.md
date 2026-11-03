# USMLE100 lecture protection

Updated 2 Nov 2026 for branch `v12-frontend`. **Enforced** means the system refuses the action. **Deterrent** means copying is still possible, but discouraged and traceable.

## What is in place (our code, staging)

| # | Protection | Type | How |
|---|---|---|---|
| 1 | Only paying, current students get a video link | Enforced | The server checks enrollment, cohort, the access period, suspension and lockdown before issuing a link (`/play/claim`). The page source never contains a link. |
| 2 | Short-lived signed links | Enforced | Bunny token: SHA-256 of the key, video and expiry. Links last 15 minutes in production (`VIDEO_LINK_MINUTES`; 2 minutes on staging). After a longer pause the player fetches a fresh link for the same viewing. |
| 3 | Access ends immediately on refund, suspension, dispute or end of access | Enforced | Each progress check (every 10 s while playing) re-checks access. On failure the video frame is removed and no new link is issued. Tested: removed within about 9 s. |
| 4 | One lecture at a time per account | Enforced | One protected tab per account. A second tab or device is refused. Playback from two places at once records a warning, and a repeat locks the account. |
| 5 | Device limit and login checks | Enforced | Device registration and limits, new-device and new-country checks, login history. |
| 6 | View limits: 2 views per lecture, each used at 90% watched (watch fully twice); 1 additional view on request, owner approves with one click; technical failures don't use a view (up to 2 per lecture) | Enforced | Watched seconds are counted on the server from the player's reports, with a 2× speed cap. A view is used at 65% watched or after 24 hours. Owner-only extra views. |
| 7 | Sealed video frame | Enforced (browser) | `sandbox="allow-scripts allow-same-origin"`: the player cannot open windows or tabs, start downloads, cast (Presentation API) or navigate the page. `allow` refuses picture-in-picture, fullscreen and screen capture inside the frame. |
| 8 | No AirPlay, Chromecast or iPhone native player | Enforced in the Bunny player | Link options `disableAirPlay=true`, `chromecast=false`, `disableIosPlayer=true`, `playsinline=true`. |
| 9 | Visible moving watermark | Deterrent and traceable | Name, account ID and session code move every 10 s. A faint repeated ID and session pattern covers the whole frame. Both stay in our full screen. |
| 10 | Watermark tampering stops playback | Enforced (in the page) | If either watermark layer is removed, hidden, faded or emptied, the video stops. |
| 11 | Pause when the page is hidden | Enforced (in the page) | Switching tab or app pauses the video and stops counting. |

Automated attack tests: 61/61 on desktop and on iPhone, iPad and Android screen profiles (Chromium with a stand-in Bunny player). Four ways Bunny's player may send its messages are tested: 9/9. Unit tests: 156.

## Bunny library settings (owner, in the Bunny dashboard)

These apply to the whole library, so they also affect the live site. Approve each one first, or test it first on a separate staging library.

| Setting | Type | Effect |
|---|---|---|
| **Embed view token authentication: on** | Enforced | A link without a valid token is refused. **Check it now:** open `https://iframe.mediadelivery.net/embed/785730/<any video id>` with no token; it must refuse to play. |
| **Allowed domains:** `usmle100.com`, plus the staging address while testing | Enforced | Players embedded on other sites are refused. Add the domain once `usmle100.com` is connected. |
| **Block direct URL file access** | Enforced | Direct file, playlist and thumbnail links are refused outside the allowed domains. |
| **MediaCage Basic DRM (free)** | Enforced against download tools | Encrypts the stream with per-session keys, playback only through the Bunny player, disables MP4 fallback. Keys reach the browser in clear form, so a skilled attacker could still capture the stream. |
| **Player controls:** untick picture-in-picture, AirPlay, Chromecast and, if offered, the player's own fullscreen | Enforced in the player | Safari ignores our picture-in-picture refusal, so only hiding the button stops it on iPad and iPhone. Our own full-screen button keeps the watermark. |
| **MP4 fallback: off** | Enforced | No downloadable MP4 files exist (MediaCage turns this off too). |

## Bunny bill (owner, 2 Nov 2026: keep cost as low as possible)

Our player link already uses `preload=false` (nothing downloads before play) and `levelCap=true` (phones get a smaller size). Bunny settings that lower the bill:
1. **Encoding:** keep only **360p and 480p**. Students can still read slides on phones and tablets; add 720p only if they report blurry text.
2. **Delivery network:** **Volume** tier, if offered.
3. **Storage replication:** one region only.
4. **MP4 fallback:** off (MediaCage Basic also turns it off). This avoids storing extra copies.
5. **Keep original files:** turn off only after the quality settings are final (originals are needed to re-encode).

## What cannot be fully prevented

- **Screen recording and phone cameras.** No website can stop someone filming the screen.
  - **MediaCage Enterprise DRM** (Widevine and FairPlay; $99/month plus about $0.005 per playback licence) turns the video black in screen recordings on iPhone, iPad and Mac (Safari) and on Android with hardware DRM.
  - On desktop Chrome and other "L3" devices it cannot block capture, and Bunny limits those devices to 480p.
  - FairPlay needs a deployment package from Apple, which is an application process.
  - Our visible watermark, with the student's name, ID and session code, means any leaked recording identifies the student.
- **A determined technical user** can disable our page's scripts. Without them, the watermark checks, tab checks and progress counting stop running.
  - What still holds: links expire in 15 minutes, the server refuses new links after any revocation, and Bunny's allowed-domains setting and DRM still apply.
- **Forensic (invisible) watermarking**: Bunny's documentation doesn't list it. It would need another provider.

## Real-device results (owner's iPhone, staging, 2 Nov 2026)

- Real Bunny video from library 785730 plays.
- Name, account ID and session code are shown, plus the tiled pattern.
- No picture-in-picture or AirPlay buttons in Bunny's controls.
- Continuous playback carried on past the 2-minute link expiry.
- Watching reached the threshold (then 65%), and the server ended the viewing. Now 2 views at 90%. This confirms that real progress reports arrive and are counted.
- Earlier, with the old player code, no progress arrived. That is what the player fix addressed.

## Real-device checks still needed

Chromium emulation can't reproduce Safari's picture-in-picture, AirPlay or native fullscreen, or Android's casting. After the Bunny settings above are applied, check these on a real iPhone, iPad and Android phone:
- no picture-in-picture, AirPlay or cast buttons;
- full screen keeps the watermark;
- a 3-minute continuous play on staging (2-minute links) keeps playing;
- pause for 3 minutes, then press play: it resumes.
