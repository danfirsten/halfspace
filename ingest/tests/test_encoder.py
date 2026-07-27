"""P2 encoder: dataset construction, augmentation invariants, embeddings, metrics.

Everything here runs on constructed fixtures where the right answer is known by
hand, except the two clearly-marked integration checks that read the real build
and skip without one.

The model tests need PyTorch, which lives in `requirements-encoder.txt` rather
than `requirements.txt` — they skip cleanly in a plain ingest environment.
"""

from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from encoder import baseline as B
from encoder.augment import crop, event_dropout, spatial_jitter, tempo_jitter, to_view
from encoder.config import TrainConfig
from encoder.data import (
    N_CHANNELS,
    NUMERIC_CHANNELS,
    TYPE_INDEX,
    featurize_segment,
    load_store,
    pad_batch,
    stride_subsample,
)
from encoder.evaluate import (
    eligible_halves,
    knn_label_scores,
    rank_of_gold,
    retrieval_metrics,
    roc_auc,
)
from halfspace_ingest import taxonomy as T
from halfspace_ingest.config import OUT_DIR

CH = {name: i for i, name in enumerate(NUMERIC_CHANNELS)}


# --------------------------------------------------------------------------
# a fixture shard, written exactly like halfspace_ingest.build writes one
# --------------------------------------------------------------------------
def _row(phase_id, idx, t, type_id, *, side="in_possession", x=None, y=None,
         ex=None, ey=None, player=None, up=False, cp=False, out=False, xg=None):
    return {
        "phase_id": phase_id, "idx": idx, "t_offset_s": t, "type_id": type_id,
        "team_side": side, "player_name": player, "x": x, "y": y,
        "end_x": ex, "end_y": ey, "under_pressure": up, "counterpress": cp,
        "out": out, "xg": xg,
    }


SCHEMA = {
    "phase_id": pl.Utf8, "idx": pl.Int16, "t_offset_s": pl.Float32, "type_id": pl.Int16,
    "team_side": pl.Categorical, "player_name": pl.Utf8, "x": pl.Float32, "y": pl.Float32,
    "end_x": pl.Float32, "end_y": pl.Float32, "under_pressure": pl.Boolean,
    "counterpress": pl.Boolean, "out": pl.Boolean, "xg": pl.Float32,
}


@pytest.fixture
def store(tmp_path, monkeypatch):
    """Two hand-built phases in match 999.

    Phase 1 is a six-event move up the left: a goal kick played 40 yards, a
    carry, an opponent pressure, a switch of play 45 yards across, then a shot.
    Phase 2 is a two-event stub. Every number below is chosen so the assertions
    can be arithmetic rather than approximate.
    """
    rows = [
        _row("999-0001", 0, 0.0, T.PASS, x=6.0, y=40.0, ex=46.0, ey=10.0, player="A"),
        _row("999-0001", 1, 2.0, T.BALL_RECEIPT, x=46.0, y=10.0, player="B"),
        _row("999-0001", 2, 2.5, T.CARRY, x=46.0, y=10.0, ex=56.0, ey=10.0, player="B"),
        _row("999-0001", 3, 4.0, T.PRESSURE, side="opponent", x=60.0, y=70.0, player="Z"),
        _row("999-0001", 4, 4.5, T.PASS, x=56.0, y=10.0, ex=76.0, ey=60.0, player="B", up=True),
        _row("999-0001", 5, 8.0, T.SHOT, x=105.0, y=40.0, ex=120.0, ey=40.0, player="C", xg=0.25),
        _row("999-0002", 0, 0.0, T.PASS, x=60.0, y=40.0, ex=70.0, ey=40.0, player="A"),
        _row("999-0002", 1, 1.0, T.MISCONTROL, x=70.0, y=40.0, player="D"),
    ]
    d = tmp_path / "phase_events"
    d.mkdir()
    pl.DataFrame(rows, schema=SCHEMA).write_parquet(d / "999.parquet")
    monkeypatch.setattr("encoder.data.EVENTS_DIR", d)
    return load_store([999])


# --------------------------------------------------------------------------
# dataset / feature tensor construction
# --------------------------------------------------------------------------
def test_store_groups_phases_and_keeps_event_order(store):
    assert store.phase_ids == ["999-0001", "999-0002"]
    assert store.n_events(0) == 6 and store.n_events(1) == 2
    assert list(store.match_ids) == [999, 999]
    assert list(store.type_id[store.start[0] : store.stop[0]]) == [
        T.PASS, T.BALL_RECEIPT, T.CARRY, T.PRESSURE, T.PASS, T.SHOT
    ]
    # side: only the pressure belongs to the opponent
    assert list(store.side[store.start[0] : store.stop[0]]) == [1, 1, 1, 0, 1, 1]
    # players are coded, and an event with no player codes to -1
    assert store.player[store.start[0]] != store.player[store.start[0] + 1]


def test_featurize_scales_and_flags(store):
    feats, types = featurize_segment(store.slice(0))
    assert feats.shape == (6, N_CHANNELS)
    assert types[0] == TYPE_INDEX[T.PASS]
    # x = 6 -> 6/60 - 1 = -0.9; y = 40 -> 0.0
    assert feats[0, CH["x"]] == pytest.approx(-0.9)
    assert feats[0, CH["y"]] == pytest.approx(0.0)
    # the opening pass travels +40 in x (/30) and -30 in y (/20)
    assert feats[0, CH["dx"]] == pytest.approx(40.0 / 30.0)
    assert feats[0, CH["dy"]] == pytest.approx(-30.0 / 20.0)
    # a Ball Receipt has no end location
    assert feats[1, CH["has_end"]] == 0.0 and feats[0, CH["has_end"]] == 1.0
    # time is relative to the segment, and the first gap is zero by construction
    assert feats[0, CH["t_rel"]] == 0.0 and feats[0, CH["dt"]] == 0.0
    assert feats[1, CH["t_rel"]] == pytest.approx(2.0 / 30.0)
    assert feats[4, CH["under_pressure"]] == 1.0
    assert feats[5, CH["xg"]] == pytest.approx(0.25)
    assert feats[3, CH["side"]] == 0.0


def test_featurize_is_translation_invariant_in_time(store):
    """A crop must not be told where in the phase it was cut from."""
    whole, _ = featurize_segment(store.slice(0))
    tail, _ = featurize_segment(store.slice(0, 2))
    assert tail[0, CH["t_rel"]] == 0.0
    assert tail[:, CH["x"]] == pytest.approx(whole[2:, CH["x"]])


def test_stride_subsample_preserves_order_and_endpoints():
    assert list(stride_subsample(5, 64)) == [0, 1, 2, 3, 4]
    idx = stride_subsample(200, 64)
    assert len(idx) <= 64
    assert idx[0] == 0 and idx[-1] == 199
    assert list(idx) == sorted(idx) and len(set(idx)) == len(idx)


def test_pad_batch_masks_padding(store):
    num, typ, mask = pad_batch([featurize_segment(store.slice(i)) for i in (0, 1)], max_len=64)
    assert num.shape == (2, 6, N_CHANNELS)
    assert mask[0].all()
    assert list(mask[1]) == [True, True, False, False, False, False]
    assert (num[1, 2:] == 0).all() and (typ[1, 2:] == 0).all()


# --------------------------------------------------------------------------
# augmentation invariants
# --------------------------------------------------------------------------
def test_crop_keeps_a_contiguous_run_in_order(store):
    view = to_view(store.slice(0))
    for seed in range(25):
        rng = np.random.default_rng(seed)
        c = crop(view, rng, keep_min=0.6)
        n = len(c["t"])
        assert 3 <= n <= 6
        # contiguity: the cropped timestamps appear as a run in the original
        t_all, t_c = list(view["t"]), list(c["t"])
        assert any(t_all[i : i + n] == t_c for i in range(len(t_all) - n + 1))


def test_event_dropout_never_drops_the_ends_and_never_empties(store):
    view = to_view(store.slice(0))
    for seed in range(50):
        rng = np.random.default_rng(seed)
        d = event_dropout(view, rng, p=0.9)
        assert len(d["t"]) >= 3
        assert d["t"][0] == view["t"][0] and d["t"][-1] == view["t"][-1]


def test_spatial_jitter_moves_locations_but_not_types_or_missingness(store):
    view = to_view(store.slice(0))
    j = spatial_jitter(view, np.random.default_rng(3), sigma=0.8)
    assert list(j["type_idx"]) == list(view["type_idx"])
    assert np.isnan(j["end_x"][1]) and np.isnan(view["end_x"][1])
    moved = np.abs(j["x"] - view["x"])
    assert moved.max() > 0 and moved.max() < 8 * 0.8  # 10 sigma is not a jitter


def test_tempo_jitter_keeps_time_monotone_and_anchored(store):
    view = to_view(store.slice(0))
    for seed in range(20):
        j = tempo_jitter(view, np.random.default_rng(seed), sigma=0.10)
        assert j["t"][0] == view["t"][0]
        assert np.all(np.diff(j["t"]) >= 0)
        # the rhythm survives: every gap is scaled by the same factor
        ratios = np.diff(j["t"]) / np.diff(view["t"])
        assert ratios.max() - ratios.min() < 1e-5
        assert 0.5 < float(ratios.mean()) < 2.0


def test_augmentations_are_reproducible_from_the_seed(store):
    from encoder.augment import augment

    cfg = TrainConfig()
    a = augment(store.slice(0), np.random.default_rng(11), cfg)
    b = augment(store.slice(0), np.random.default_rng(11), cfg)
    c = augment(store.slice(0), np.random.default_rng(12), cfg)
    assert np.array_equal(a["x"], b["x"]) and np.array_equal(a["t"], b["t"])
    assert not (len(a["x"]) == len(c["x"]) and np.array_equal(a["x"], c["x"]))


# --------------------------------------------------------------------------
# the baseline, recomputed for a slice
# --------------------------------------------------------------------------
def test_segment_features_match_the_published_definitions(store):
    f = B.segment_features(store.slice(0))
    # ball path: our events only, pressure excluded, consecutive duplicates dropped
    # (6,40) (46,10) (56,10) (76,60) (105,40) (120,40)
    assert (f["start_x"], f["start_y"]) == (6.0, 40.0)
    assert (f["end_x"], f["end_y"]) == (120.0, 40.0)
    assert f["max_x"] == 120.0
    assert f["n_passes"] == 2 and f["n_events"] == 6
    assert f["n_players"] == 3  # A, B, C — the opponent's Z does not count
    assert f["pressure_events"] == 1
    assert f["xg"] == pytest.approx(0.25)
    assert f["duration_s"] == pytest.approx(8.0)
    assert f["progression_m"] == pytest.approx((120.0 - 6.0) * 0.9144)
    assert f["switch_of_play"] is True  # the 10 -> 60 pass moves 50 yards across
    assert f["reached_final_third"] is True and f["reached_box"] is True
    assert f["start_zone"] == "def_third_centre" and f["end_zone"] == "final_third_centre"
    assert len(f["path_xy"]) == 40


def test_segment_features_of_a_half_use_only_that_half(store):
    first = B.segment_features(store.slice(0, 0, 3))
    assert (first["end_x"], first["end_y"]) == (56.0, 10.0)
    assert first["reached_final_third"] is False
    assert first["switch_of_play"] is False
    assert first["n_passes"] == 1


def test_eligibility_needs_eight_events_and_two_path_events_per_half(store):
    h = eligible_halves(store)
    assert list(h.index) == []  # 6 and 2 events: both below the 8-event floor


# --------------------------------------------------------------------------
# metrics, on toy cases with known answers
# --------------------------------------------------------------------------
def _unit(rows):
    a = np.array(rows, dtype=np.float64)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


def test_rank_of_gold_perfect_and_worst_cases():
    q = _unit([[1, 0], [0, 1]])
    c = _unit([[1, 0], [0, 1]])
    assert list(rank_of_gold(q, c, np.array([0, 1]))) == [1.0, 1.0]
    # gold swapped: each query's gold is the orthogonal candidate -> rank 2
    assert list(rank_of_gold(q, c, np.array([1, 0]))) == [2.0, 2.0]


def test_rank_of_gold_counts_ties_as_half():
    """A collapsed representation must score chance, not a perfect 1.0."""
    q = _unit([[1, 0], [1, 0]])
    c = _unit([[1, 0], [1, 0], [1, 0], [1, 0]])
    ranks = rank_of_gold(q, c, np.array([0, 1]))
    assert list(ranks) == [2.5, 2.5]  # 1 + 0 greater + 3/2 tied


def test_retrieval_metrics_arithmetic():
    m = retrieval_metrics(np.array([1.0, 2.0, 10.0, 100.0]))
    assert m["n"] == 4
    assert m["mrr"] == pytest.approx((1 + 0.5 + 0.1 + 0.01) / 4)
    assert m["recall@1"] == 0.25
    assert m["recall@10"] == 0.75
    assert m["median_rank"] == 6.0


def test_roc_auc_known_values():
    labels = np.array([0, 0, 1, 1], dtype=float)
    assert roc_auc(np.array([0.1, 0.2, 0.8, 0.9]), labels) == 1.0
    assert roc_auc(np.array([0.9, 0.8, 0.2, 0.1]), labels) == 0.0
    assert roc_auc(np.array([0.5, 0.5, 0.5, 0.5]), labels) == 0.5
    # one positive ranked below one negative out of four pairs -> 0.75
    assert roc_auc(np.array([0.1, 0.5, 0.4, 0.9]), labels) == pytest.approx(0.75)
    assert np.isnan(roc_auc(np.array([0.1, 0.2]), np.array([1.0, 1.0])))


def test_knn_label_scores_excludes_the_point_itself():
    # four vectors: two at 0 degrees carrying label 1, two at 90 carrying label 0
    v = _unit([[1, 0], [1, 0.01], [0, 1], [0.01, 1]])
    y = np.array([[1.0], [1.0], [0.0], [0.0]])
    s = knn_label_scores(v, y, k=1)
    assert list(s[:, 0]) == [1.0, 1.0, 0.0, 0.0]
    # a point's own label must not be what it retrieves
    y2 = np.array([[1.0], [0.0], [1.0], [0.0]])
    assert list(knn_label_scores(v, y2, k=1)[:, 0]) == [0.0, 1.0, 0.0, 1.0]


# --------------------------------------------------------------------------
# the model
# --------------------------------------------------------------------------
@pytest.fixture
def torch_model():
    pytest.importorskip("torch", reason="torch lives in requirements-encoder.txt")
    from encoder.model import PhaseEncoder, set_determinism

    set_determinism(TrainConfig().seed)
    return PhaseEncoder(TrainConfig())


def test_model_is_small_enough_and_within_the_contract_budget(torch_model):
    assert torch_model.n_params() < 1_000_000
    assert TrainConfig().out_dim <= 96  # docs/CONTRACT.md §7


def test_embeddings_are_unit_length_and_the_right_shape(torch_model, store):
    from encoder.infer import embed_segments

    cfg = TrainConfig()
    z = embed_segments(torch_model.eval(), cfg, [store.slice(0), store.slice(1)])
    assert z.shape == (2, cfg.out_dim)
    assert np.allclose(np.linalg.norm(z, axis=1), 1.0, atol=1e-5)


def test_embeddings_are_deterministic_given_the_seed(store):
    pytest.importorskip("torch", reason="torch lives in requirements-encoder.txt")
    from encoder.infer import embed_segments
    from encoder.model import PhaseEncoder, set_determinism

    cfg = TrainConfig()
    out = []
    for _ in range(2):
        set_determinism(cfg.seed)
        m = PhaseEncoder(cfg).eval()
        out.append(embed_segments(m, cfg, [store.slice(0), store.slice(1)]))
    assert np.array_equal(out[0], out[1])

    set_determinism(cfg.seed + 1)
    other = embed_segments(PhaseEncoder(cfg).eval(), cfg, [store.slice(0)])
    assert not np.allclose(other[0], out[0][0])


def test_nt_xent_is_lower_when_the_pairs_agree():
    pytest.importorskip("torch", reason="torch lives in requirements-encoder.txt")
    import torch

    from encoder.model import nt_xent

    a = torch.nn.functional.normalize(torch.randn(16, 8, generator=torch.manual_seed(0)), dim=-1)
    aligned = nt_xent(a, a.clone(), 0.07)
    shuffled = nt_xent(a, a[torch.randperm(16, generator=torch.manual_seed(1))], 0.07)
    assert aligned < shuffled


# --------------------------------------------------------------------------
# integration: the recomputed baseline against the artifact the app ships
# --------------------------------------------------------------------------
@pytest.mark.skipif(
    not (OUT_DIR / "similarity.parquet").exists(),
    reason="no build present; run `python -m halfspace_ingest.build` first",
)
def test_recomputed_baseline_reproduces_the_shipped_vectors():
    """If this drifts, every half-phase baseline number in RESULTS.md is suspect."""
    from encoder.config import load_splits
    from encoder.data import load_store as real_load_store

    st = real_load_store(load_splits()["validation"][:3])
    rep = B.check_reproduction(st, n=200)
    assert rep["cosine_mean"] > 0.99
    assert rep["cosine_p05"] > 0.98
