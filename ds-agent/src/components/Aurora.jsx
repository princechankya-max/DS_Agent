export default function Aurora() {
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', background: 'radial-gradient(circle, rgba(139,124,248,0.15) 0%, transparent 70%)', top: '-20%', left: '-10%', animation: 'pulse 9s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', width: 600, height: 600, borderRadius: '50%', background: 'radial-gradient(circle, rgba(94,207,178,0.11) 0%, transparent 70%)', bottom: '-15%', right: '-8%', animation: 'pulse 9s ease-in-out infinite', animationDelay: '-4.5s' }} />
        <div style={{ position: 'absolute', width: 450, height: 450, borderRadius: '50%', background: 'radial-gradient(circle, rgba(245,168,200,0.09) 0%, transparent 70%)', top: '25%', right: '18%', animation: 'pulse 9s ease-in-out infinite', animationDelay: '-2s' }} />
      </div>
    </>
  );
}
