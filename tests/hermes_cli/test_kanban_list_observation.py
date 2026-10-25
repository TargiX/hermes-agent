"""Observing a board must not promote tasks whose dependencies just cleared."""
import json
from pathlib import Path
import pytest
from hermes_cli import kanban as cli
from hermes_cli import kanban_db as kb
from hermes_cli import kanban_db_connect as kbc


@pytest.mark.parametrize('verb', ['list', 'ls'])
def test_no_refresh_preserves_pending_task_and_events(tmp_path, monkeypatch, verb):
    home = tmp_path / '.hermes'
    home.mkdir()
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    kb.init_db()
    with kbc.connect_closing() as conn:
        parent = kb.create_task(conn, title='parent')
        child = kb.create_task(conn, title='child', parents=[parent])
        # Model a dependency completion awaiting the next dispatcher tick.
        conn.execute("UPDATE tasks SET status='done' WHERE id=?", (parent,))
        conn.commit()
        before = kb.get_task(conn, child).status
        events = len(kb.list_events(conn, child))
    rows = json.loads(cli.run_slash(f'{verb} --json --no-refresh'))
    assert next(r for r in rows if r['id'] == child)['status'] == before == 'todo'
    with kbc.connect_closing() as conn:
        assert kb.get_task(conn, child).status == before
        assert len(kb.list_events(conn, child)) == events
    refreshed = json.loads(cli.run_slash(f'{verb} --json'))
    assert next(r for r in refreshed if r['id'] == child)['status'] == 'ready'
