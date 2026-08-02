import numpy as np

import mel_np


def test_configurable_hop_preserves_default_and_changes_only_frame_grid():
    audio = np.random.default_rng(4).standard_normal(8_000).astype(np.float32)
    default = mel_np.logmel(audio)
    explicit = mel_np.logmel(audio, hop=mel_np.HOP)
    fine = mel_np.logmel(audio, hop=160)
    np.testing.assert_array_equal(default, explicit)
    assert default.shape == (mel_np.N_MELS, 1 + len(audio) // mel_np.HOP)
    assert fine.shape == (mel_np.N_MELS, 1 + len(audio) // 160)


def test_configurable_hop_rejects_invalid_values():
    audio = np.zeros(4_096, dtype=np.float32)
    for hop in (0, -1, 160.0):
        try:
            mel_np.logmel(audio, hop=hop)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid hop accepted: {hop!r}")
