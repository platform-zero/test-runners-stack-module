#!/usr/bin/env python3
"""SOURCE ONLY: cut-owned metadata removed; human-finance inputs not delivered."""
from pathlib import Path
text=(Path(__file__).resolve().parents[1]/'stack.runtime.yaml').read_text()
for cut in ['VAULTWARDEN','vaultwarden.','LIBRECHAT','librechat.','WORKLOAD_SPAWNER','workload-spawner.']:
 assert cut not in text,cut
assert 'FIREFLY_' not in text
assert 'JUPYTER_NOTEBOOK_IMAGE:' in text and 'FORGEJO_USERNAME:' in text
assert 'BOOKSTACK_API_TOKEN_SECRET:' in text
print('SOURCE ONLY: cut-owned runner delivery absent; no finance input delivery; retained notebook/Forgejo/BookStack contracts preserved')
