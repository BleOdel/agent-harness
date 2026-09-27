ARG BASE
FROM ${BASE}
COPY wheels /tmp/torch-wheels
COPY requirements.lock /tmp/torch.lock
RUN python3 -I -m pip install --no-cache-dir --no-index --find-links=/tmp/torch-wheels --require-hashes --only-binary=:all: -r /tmp/torch.lock && rm -rf /tmp/torch-wheels /tmp/torch.lock
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=1
