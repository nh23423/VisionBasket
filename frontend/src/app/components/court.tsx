'use client';

import { useRef,useState } from 'react';

const COLORS = [
  '#FF4136', '#2ECC40', '#0074D9', '#FF69B4', '#FF851B',
  '#B10DC9', '#01FF70', '#FFDC00', '#7FDBFF', '#F012BE',
];

export default function CourtDisplay({
  backgroundColor = 'white',
  isPlotting = false,
  points = [],
}: {
  backgroundColor?: string
  isPlotting?: boolean
  points?: [number, number][]
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const scalePoint = ([x, y]: [number, number]): [string, string] => {
    // Plot by percentage instead of hardcoded pixels
    const img = imgRef.current;
    if (!img) return ['0%', '0%'];
    const pctX = (x / img.naturalWidth) * 100;
    const pctY = (y / img.naturalHeight) * 100;
    return [`${pctX}%`, `${pctY}%`];
  };

  return (
    <div
      className="relative w-full h-full overflow-hidden"
      style={{ backgroundColor }}
    >
      <img
        ref={imgRef}
        src="/mpl_nba_court.png"
        alt="2D NBA Court"
        className="w-full h-full object-fill"
        onLoad={() => setImgLoaded(true)}
        />

      {isPlotting && imgLoaded && points.map((pt, index) => {
        if (!pt) return null;
        const [px, py] = scalePoint(pt);
        const color = COLORS[index % COLORS.length];
        return (
            <div
                key={index}
                className="absolute rounded-full"
                style={{ left: px, top: py, width: 10, height: 10, backgroundColor: color, transform: 'translate(-50%, -50%)', zIndex: 10 }}
            />
        );
    })}
    </div>
  );
}