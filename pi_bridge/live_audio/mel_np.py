"""Pure-numpy log-mel matching torchaudio MelSpectrogram(power=2)+AmplitudeToDB(power,top_db=80).
Params fixed to the O&V model: sr=16000, n_fft=2048, hop=384, n_mels=229, fmin=50, fmax=8000, htk."""
import numpy as np

SR, N_FFT, HOP, N_MELS, FMIN, FMAX = 16000, 2048, 384, 229, 50, 8000

def _hann_periodic(n):
    return (0.5 - 0.5*np.cos(2*np.pi*np.arange(n)/n)).astype(np.float64)

def _hz_to_mel_htk(f): return 2595.0*np.log10(1.0 + f/700.0)
def _mel_to_hz_htk(m): return 700.0*(10.0**(m/2595.0) - 1.0)

def mel_filterbank():
    n_freqs = N_FFT//2 + 1
    all_freqs = np.linspace(0, SR/2, n_freqs)
    m_pts = np.linspace(_hz_to_mel_htk(FMIN), _hz_to_mel_htk(FMAX), N_MELS+2)
    f_pts = _mel_to_hz_htk(m_pts)
    fb = np.zeros((n_freqs, N_MELS))
    for i in range(N_MELS):
        lo, ce, up = f_pts[i], f_pts[i+1], f_pts[i+2]
        left = (all_freqs - lo)/(ce - lo)
        right = (up - all_freqs)/(up - ce)
        fb[:, i] = np.maximum(0.0, np.minimum(left, right))
    return fb  # (n_freqs, n_mels)

_WIN = _hann_periodic(N_FFT)
_FB = mel_filterbank()

def logmel(wav, top_db_ref=None, hop=HOP):
    """wav: 1D float32 @16k. Returns (229, T) float32 log-mel.
    hop: analysis hop in samples. The note model uses 384; the independently
    trained pedal model uses 160 while sharing every other spectral parameter.
    top_db_ref: if given, use this as the reference max for the -80dB floor
    (for streaming continuity); else use this signal's own max (matches full-file torchaudio)."""
    if not isinstance(hop, int) or hop <= 0:
        raise ValueError("hop must be a positive integer")
    x = np.asarray(wav, dtype=np.float64)
    pad = N_FFT//2
    xp = np.pad(x, (pad, pad), mode="reflect")
    n_frames = 1 + (len(xp) - N_FFT)//hop
    idx = np.arange(N_FFT)[None, :] + hop*np.arange(n_frames)[:, None]
    frames = xp[idx]*_WIN                      # (T, n_fft)
    spec = np.fft.rfft(frames, n=N_FFT, axis=1)
    power = (spec.real**2 + spec.imag**2)      # (T, n_freqs)
    mel = power @ _FB                          # (T, n_mels)
    mel = mel.T                                # (n_mels, T)
    db = 10.0*np.log10(np.maximum(mel, 1e-10))
    ref = db.max() if top_db_ref is None else top_db_ref
    db = np.maximum(db, ref - 80.0)
    return db.astype(np.float32)
