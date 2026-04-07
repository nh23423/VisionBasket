'use client';

import { useRef, useState } from 'react';

const COLORS = [
  '#FF4136', '#2ECC40', '#0074D9', '#FF69B4', '#FF851B',
  '#B10DC9', '#01FF70', '#FFDC00', '#7FDBFF', '#F012BE',
];

export default function CourtDisplay({
  backgroundColor = 'white',
  isPlotting = false,
  points = [],
}: {
  backgroundColor?: string;
  isPlotting?: boolean;
  points?: any[];
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  const scalePoint = (pt: [number, number]): [string, string] => {
    const img = imgRef.current;
    if (!img || !pt) return ['0%', '0%'];
    const [x, y] = pt;
    const pctX = (x / img.naturalWidth) * 100;
    const pctY = (y / img.naturalHeight) * 100;
    return [`${pctX}%`, `${pctY}%`];
  };

  return (
    <div className="relative w-full h-full overflow-hidden" style={{ backgroundColor }}>
      <img
        ref={imgRef}
        src="/mpl_nba_court.png"
        alt="2D NBA Court"
        className="w-full h-full object-fill block"
        onLoad={() => setImgLoaded(true)}
      />

      {isPlotting && imgLoaded && points.map((p, index) => {
        if (!p) return null;
        
        // Check if this is a Radar Point (has an ID from the detection engine)
        const isRadarPoint = typeof p === 'object' && !Array.isArray(p) && p.id !== undefined;

        if (isRadarPoint) {
          const [px, py] = scalePoint(p.pt);
          
          const dotColor = COLORS[p.id % COLORS.length];
          
          return (
            <div
              key={`radar-${p.id}`}
              className="absolute rounded-full flex items-center justify-center text-white font-bold shadow-[0_0_4px_rgba(0,0,0,0.5)] border border-white/50 transition-all duration-300"
              style={{
                left: px,
                top: py,
                width: 18, // Slightly larger to fit text
                height: 18,
                backgroundColor: dotColor,
                transform: 'translate(-50%, -50%)',
                zIndex: 10,
                fontSize: '8px' // Small ID text inside the dot
              }}
            >
              {p.id} 
            </div>
          );
        } else {
          // This is a Setup/Calibration point (the 7 points for the camera)
          const [px, py] = scalePoint(p as [number, number]);
          
          // Calibration points usually follow their own sequence (1-7)
          const setupColor = COLORS[index % COLORS.length];
          
          return (
            <div
              key={`setup-${index}`}
              className="absolute rounded-full flex items-center justify-center text-white font-bold text-[10px] shadow-md border border-white/50"
              style={{ 
                left: px, 
                top: py, 
                width: 22, 
                height: 22, 
                backgroundColor: setupColor, 
                transform: 'translate(-50%, -50%)', 
                zIndex: 20,
              }}
            >
              {index + 1}
            </div>
          );
        }
      })}
    </div>
  );
}