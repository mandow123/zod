from __future__ import annotations

from kai_recsys_lab.smoke import run_synthetic_smoke


def test_synthetic_smoke_covers_all_modules_without_business_claims() -> None:
    report = run_synthetic_smoke()
    assert report["dataOrigin"] == "synthetic"
    assert report["businessData"] is False
    assert report["claimablePerformance"] is False
    assert set(report["modules"]) == {"retrieval", "sequence", "ctr", "conversion", "debias", "ads"}
    assert all(module["status"] == "passed" for module in report["modules"].values())
