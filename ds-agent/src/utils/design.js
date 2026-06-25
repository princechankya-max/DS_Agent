// ── DS Agent Design System ──
export const C = {
  bg:           '#05060F',
  surface:      'rgba(255,255,255,0.03)',
  glass:        'rgba(255,255,255,0.06)',
  glassMd:      'rgba(255,255,255,0.10)',
  border:       'rgba(255,255,255,0.08)',
  borderBright: 'rgba(255,255,255,0.16)',
  primary:      '#8B7CF8',
  primaryDark:  '#6B5CE7',
  teal:         '#5ECFB2',
  amber:        '#F5C97A',
  coral:        '#FF5370',
  rose:         '#F5A8C8',
  cyan:         '#22D3EE',
  text:         '#EEF0FF',
  muted:        '#8891AA',
  dim:          '#3A3F5C',
};

export const PALETTE = [C.primary,C.teal,C.amber,C.coral,C.rose,C.cyan,'#F97316','#A3E635'];

export const G = {
  panel: (e={}) => ({
    background: C.glass,
    backdropFilter: 'blur(32px)',
    WebkitBackdropFilter: 'blur(32px)',
    border: `1px solid ${C.border}`,
    borderRadius: 20,
    ...e,
  }),
  panelMd: (e={}) => ({
    background: C.glassMd,
    backdropFilter: 'blur(32px)',
    WebkitBackdropFilter: 'blur(32px)',
    border: `1px solid ${C.borderBright}`,
    borderRadius: 20,
    ...e,
  }),
  btn: (grad, sm) => ({
    background: grad,
    color: '#fff',
    border: 'none',
    borderRadius: sm ? 10 : 12,
    padding: sm ? '8px 18px' : '13px 28px',
    fontSize: sm ? 12 : 14,
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.2px',
    transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
    fontFamily: 'inherit',
    outline: 'none',
  }),
  pill: (c) => ({
    background: `${c}18`,
    color: c,
    border: `1px solid ${c}33`,
    borderRadius: 20,
    padding: '4px 12px',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.3px',
    display: 'inline-block',
  }),
  input: (e={}) => ({
    background: 'rgba(255,255,255,0.05)',
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    color: C.text,
    fontSize: 14,
    padding: '12px 16px',
    width: '100%',
    fontFamily: 'inherit',
    outline: 'none',
    transition: 'border-color 0.2s',
    ...e,
  }),
};

export const FONT = "'Inter', system-ui, -apple-system, sans-serif";

export const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ${FONT}; background: ${C.bg}; color: ${C.text}; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2d45; border-radius: 3px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes pulse { 0%, 100% { opacity: 0.6; transform: scale(1); } 50% { opacity: 1; transform: scale(1.08); } }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  input:focus { border-color: #8B7CF8 !important; box-shadow: 0 0 0 3px rgba(139,124,248,0.12); }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; }
  a { text-decoration: none; color: inherit; }
`;
