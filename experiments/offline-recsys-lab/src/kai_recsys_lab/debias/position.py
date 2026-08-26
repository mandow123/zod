from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class PositionAsFeatureBaseline:
    """Declaration for an associational position-feature baseline.

    Including position as a feature can improve click prediction while learning
    the exposure shortcut itself. It is therefore deliberately marked as a
    naive baseline, not as a debiasing method.
    """

    name: str = field(default="position_as_feature", init=False)
    methodology: str = field(default="naive_associational_baseline", init=False)
    is_debiasing: bool = field(default=False, init=False)
