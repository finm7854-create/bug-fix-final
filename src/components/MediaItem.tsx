import React from 'react';
import { useResolvedUrl } from '../lib/useResolvedUrl';

interface ResolvedImgProps {
  src: string;
  alt: string;
  className?: string;
  onClick?: () => void;
  onError?: (e: React.SyntheticEvent<HTMLImageElement, Event>) => void;
}

export const ResolvedImg: React.FC<ResolvedImgProps> = ({ src, alt, className, onClick, onError }) => {
  const resolved = useResolvedUrl(src);
  return (
    <img
      src={resolved || src}
      alt={alt}
      className={className}
      onClick={onClick}
      onError={onError}
    />
  );
};

interface ResolvedVideoProps {
  src: string;
  className?: string;
  isThumbnail?: boolean;
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const ResolvedVideo: React.FC<ResolvedVideoProps> = ({
  src,
  className,
  isThumbnail,
  autoPlay,
  muted = false,
  controls = true,
  videoRef,
  onMouseEnter,
  onMouseLeave
}) => {
  const resolved = useResolvedUrl(src);
  const finalSrc = resolved || src;
  const localVideoRef = React.useRef<HTMLVideoElement | null>(null);

  const setVideoRef = (node: HTMLVideoElement | null) => {
    localVideoRef.current = node;
    if (videoRef) {
      if (typeof videoRef === 'function') {
        (videoRef as any)(node);
      } else {
        (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = node;
      }
    }
  };

  const handleMouseEnterInternal = () => {
    if (localVideoRef.current) {
      localVideoRef.current.muted = true;
      localVideoRef.current.play().catch(() => {});
    }
    if (onMouseEnter) onMouseEnter();
  };

  const handleMouseLeaveInternal = () => {
    if (localVideoRef.current) {
      localVideoRef.current.pause();
    }
    if (onMouseLeave) onMouseLeave();
  };

  if (isThumbnail) {
    if (finalSrc.includes('drive.google.com')) {
      return (
        <div className="w-full h-full bg-gradient-to-br from-slate-900 to-slate-950 flex items-center justify-center">
          <div className="w-10 h-10 rounded-full bg-[#00dce6]/20 border border-[#00dce6]/40 flex items-center justify-center">
            <span className="text-xs font-bold text-[#00dce6]">DRIVE</span>
          </div>
        </div>
      );
    }
    return (
      <video
        key={finalSrc}
        ref={setVideoRef}
        src={finalSrc}
        muted={muted}
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        className={className || "w-full h-full object-cover transition-transform duration-300 ease-out hover:scale-105"}
        onMouseEnter={handleMouseEnterInternal}
        onMouseLeave={handleMouseLeaveInternal}
      />
    );
  }

  if (finalSrc.includes('drive.google.com')) {
    return (
      <iframe
        key={finalSrc}
        src={finalSrc.includes('/preview') ? finalSrc : `${finalSrc}/preview`}
        className={className || "w-full aspect-video min-h-[300px] sm:min-h-[420px] border-0 bg-black"}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        title="Google Drive Video Clip"
      />
    );
  }

  return (
    <video
      key={finalSrc}
      ref={setVideoRef}
      controls={controls}
      autoPlay={autoPlay}
      muted={muted}
      playsInline
      src={finalSrc}
      className={className || "w-full aspect-video min-h-[300px] sm:min-h-[420px] object-contain bg-black"}
      onMouseEnter={handleMouseEnterInternal}
      onMouseLeave={handleMouseLeaveInternal}
    >
      Your browser does not support HTML5 video.
    </video>
  );
};

interface ResolvedAudioProps {
  src: string;
  className?: string;
}

export const ResolvedAudio: React.FC<ResolvedAudioProps> = ({ src, className }) => {
  const resolved = useResolvedUrl(src);
  return (
    <audio controls src={resolved || src} className={className || "w-full h-8"}>
      Your browser does not support audio.
    </audio>
  );
};
