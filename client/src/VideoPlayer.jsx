import { useEffect, useRef } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import { isAnyFullscreen } from "./fullscreen.js";

function pathnameLower(url) {
  try {
    return new URL(url, window.location.origin).pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

export default function VideoPlayer({ src, title }) {
  const ref = useRef(null);

  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;

    let hls;
    let tsPlayer;

    const path = pathnameLower(src);
    const isM3u8 = path.endsWith(".m3u8") || src.toLowerCase().includes(".m3u8");
    const isTs = path.endsWith(".ts");

    const cleanup = () => {
      if (hls) {
        hls.destroy();
        hls = undefined;
      }
      if (tsPlayer) {
        try {
          tsPlayer.pause();
          tsPlayer.unload();
          tsPlayer.detachMediaElement();
          tsPlayer.destroy();
        } catch {
          /* noop */
        }
        tsPlayer = undefined;
      }
      video.removeAttribute("src");
      video.load();
    };

    if (isM3u8 && Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              hls = undefined;
              break;
          }
        }
      });
    } else if (isM3u8 && video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
    } else if (isTs && mpegts.isSupported()) {
      tsPlayer = mpegts.createPlayer(
        {
          type: "mpegts",
          isLive: true,
          url: src,
        },
        {
          enableWorker: true,
          liveBufferLatencyChasing: true,
        }
      );
      tsPlayer.attachMediaElement(video);
      tsPlayer.load();
    } else {
      video.src = src;
    }

    const tryVideoFullscreen = () => {
      if (isAnyFullscreen()) return;
      try {
        if (typeof video.webkitEnterFullscreen === "function") {
          video.webkitEnterFullscreen();
          return;
        }
        const r = video.requestFullscreen || video.webkitRequestFullscreen;
        if (r) r.call(video).catch(() => {});
      } catch {
        /* noop */
      }
    };

    video
      .play()
      .then(() => {
        requestAnimationFrame(tryVideoFullscreen);
      })
      .catch(() => {});

    return cleanup;
  }, [src]);

  const looks4K = /4k|uhd|2160|ultra\s*hd/i.test(title || "");

  return (
    <div className="nf-player-wrap">
      {title ? <div className="nf-player-label">{title}</div> : null}
      {looks4K ? (
        <p className="nf-player-codec-hint">
          Muchas películas 4K llevan sonido <strong>AC3 / EAC3 / DTS</strong>. Chrome y Firefox a menudo{" "}
          <strong>no decodifican ese audio</strong> en la web (sí suele ir el vídeo). Prueba{" "}
          <strong>Safari</strong> (Mac/iPhone), <strong>Edge</strong> o una copia <strong>1080p</strong> si
          la lista la incluye.
        </p>
      ) : null}
      <video ref={ref} className="nf-player-video" controls playsInline />
    </div>
  );
}
