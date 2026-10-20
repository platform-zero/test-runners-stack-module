#!/usr/bin/env python3
"""SOURCE ONLY: cut-owned metadata removed; human-finance inputs not delivered."""
from pathlib import Path
text=(Path(__file__).resolve().parents[1]/'stack.runtime.yaml').read_text()
for cut in ['VAULTWARDEN','vaultwarden.','LIBRECHAT','librechat.','WORKLOAD_SPAWNER','workload-spawner.']:
 assert cut not in text,cut
assert 'FIREFLY_' not in text
assert 'JUPYTER_NOTEBOOK_IMAGE:' in text and 'FORGEJO_USERNAME:' in text
assert 'BOOKSTACK_API_TOKEN_SECRET:' in text
containerfile=(Path(__file__).resolve().parents[1]/'stack.containers/test-runner/Containerfile').read_text()
assert '    python3 \\' in containerfile and '    python3-websocket \\' in containerfile
assert 'stack.containers/test-runner/retained-workflows /app/retained-workflows' in containerfile
assert 'websocket.__version__ in ("1.7.0", "1.8.0")' in containerfile
assert 'firefly-private-tests' not in containerfile
print('SOURCE ONLY: cuts/finance inputs absent; retained notebook/Forgejo/BookStack and explicit supported native-channel packaging preserved')
