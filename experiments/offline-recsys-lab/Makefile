PYTHON := .venv/bin/python

.PHONY: setup boundary smoke test verify-public verify-playground playground playground-data export-playground

setup:
	$(PYTHON) -m pip install -e .

boundary:
	$(PYTHON) scripts/verify_boundaries.py

smoke: boundary
	$(PYTHON) -m kai_recsys_lab.cli synthetic-smoke --output artifacts/synthetic-smoke.json

test: boundary
	$(PYTHON) -m pytest

verify-public: boundary
	$(PYTHON) scripts/verify_public_reports.py \
		reports/amazon-retrieval-v1-results.json \
		reports/amazon-sequence-v1-results.json \
		reports/criteo-ctr-v1-results.json \
		reports/position-bias-open-bandit-full-ope-v1.json \
		reports/position-bias-open-bandit-small-v1.json

playground-data:
	$(PYTHON) scripts/build_playground_data.py

export-playground:
	$(PYTHON) scripts/export_playground.py

verify-playground:
	$(PYTHON) scripts/verify_playground.py

playground:
	@echo "Recommendation Algorithm Playground: http://127.0.0.1:4190/playground/"
	$(PYTHON) -m http.server 4190 --bind 127.0.0.1 --directory .
