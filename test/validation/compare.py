"""Compare physical copper, connectivity, and normalized KiCad DRC findings."""
import json
import sys
from collections import Counter

import pcbnew
from kicad import copper_items, snapshot


def item_key(item):
    value = [item.GetClass(), item.GetNetname(),
             item.GetPosition().x, item.GetPosition().y]
    if item.GetClass() == 'PAD':
        pad = pcbnew.Cast_to_PAD(item)
        value += [pad.GetParentFootprint().GetReference(), pad.GetNumber()]
    if item.GetClass() in ['PCB_TRACK', 'PCB_ARC']:
        track = pcbnew.Cast_to_PCB_TRACK(item)
        value += [track.GetStart().x, track.GetStart().y,
                  track.GetEnd().x, track.GetEnd().y,
                  track.GetWidth(), track.GetLayer()]
    return json.dumps(value)


def connectivity(board):
    connection = board.GetConnectivity()
    connection.Build(board)
    items = list(copper_items(board.Tracks()))
    items += [pad for footprint in board.GetFootprints() for pad in footprint.Pads()]
    items += list(board.Zones())
    graph = []
    for item in items:
        neighbors = connection.GetConnectedItems(item)
        graph.append([item_key(item), sorted(item_key(neighbors[i])
                                            for i in range(len(neighbors)))])
    return sorted(graph, key=str)


def normalize(value):
    if isinstance(value, list):
        return sorted((normalize(item) for item in value), key=str)
    if not isinstance(value, dict):
        return value
    # Short-circuit descriptions repeat the nets already preserved in items;
    # KiCad reports that pair in either order across identical-file DRC runs.
    return {
        key: normalize(item) for key, item in value.items()
        if key != 'uuid' and not (
            key == 'description' and value.get('type') == 'shorting_items')
    }


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: compare.py BOARD8 BOARD10 DRC8.json DRC10.json')
    boards = [pcbnew.LoadBoard(path) for path in sys.argv[1:3]]
    assert snapshot(boards[0]) == snapshot(boards[1]), 'Geometry or net mismatch'
    graphs = [connectivity(board) for board in boards]
    assert graphs[0] == graphs[1], 'Connectivity mismatch'
    reports = [json.load(open(path)) for path in sys.argv[3:5]]
    findings = [Counter(json.dumps(item, sort_keys=True)
                        for item in normalize(report['violations']))
                for report in reports]
    assert findings[0] == findings[1], 'DRC finding mismatch'
    # Ratsnest representatives vary; compare full connectivity and their count.
    counts = [len(report['unconnected_items']) for report in reports]
    assert counts[0] == counts[1], 'Unconnected count mismatch'
    print(f'{len(graphs[0])} connectivity records and '
          f'{sum(findings[0].values())} DRC violations match; '
          f'{counts[0]} unconnected items remain')
