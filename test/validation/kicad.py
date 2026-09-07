"""Snapshot a temporary board's geometry and nets, then save a native copy."""
import json
import sys

import pcbnew


def xy(point):
    return [point.x, point.y]


def copper_items(container):
    # KiCad 10's Python 3.14 SWIG iterator lacks next(); use its explicit API.
    iterator = container.iterator()
    while not iterator.equal(container.end()):
        yield iterator.value()
        iterator.incr()


def contour(chain):
    return {
        'points': [xy(chain.CPoint(i)) for i in range(chain.PointCount())],
        'arcs': [
            [xy(chain.Arc(i).GetStart()), xy(chain.Arc(i).GetArcMid()),
             xy(chain.Arc(i).GetEnd())]
            for i in range(chain.ArcCount())
        ],
    }


def polygons(shape):
    return [
        {
            'outline': contour(shape.Outline(i)),
            'holes': [contour(shape.Hole(i, j))
                      for j in range(shape.HoleCount(i))],
        }
        for i in range(shape.OutlineCount())
    ]


def snapshot(board):
    footprints = []
    for footprint in board.GetFootprints():
        pads = []
        for pad in footprint.Pads():
            pads.append([
                pad.GetNumber(), xy(pad.GetPosition()),
                pad.GetOrientationDegrees(), xy(pad.GetSize()),
                xy(pad.GetDrillSize()), pad.GetNetname(),
                pad.GetLayerSet().FmtHex(),
            ])
        footprints.append([
            footprint.GetReference(), xy(footprint.GetPosition()),
            footprint.GetOrientationDegrees(), sorted(pads, key=str),
        ])

    tracks = []
    for item in copper_items(board.Tracks()):
        # SWIG returns base proxies; cast before reading subtype geometry.
        details = {}
        if item.GetClass() == 'PCB_VIA':
            item = pcbnew.Cast_to_PCB_VIA(item)
            details = {
                'drill': item.GetDrillValue(),
                'layers': [item.TopLayer(), item.BottomLayer()],
                'type': item.GetViaType(),
            }
            width = item.GetWidth(item.GetLayer())
        else:
            width = item.GetWidth()
            if item.GetClass() == 'PCB_ARC':
                item = pcbnew.Cast_to_PCB_ARC(item)
                details = {'mid': xy(item.GetMid())}
        tracks.append([
            item.GetClass(), xy(item.GetStart()), xy(item.GetEnd()),
            width, item.GetNetname(), item.GetLayerName(), details,
        ])
    zones = []
    for zone in board.Zones():
        zones.append({
            'net': zone.GetNetname(),
            'layers': zone.GetLayerSet().FmtHex(),
            'polygons': polygons(zone.Outline()),
            'priority': zone.GetAssignedPriority(),
            'clearance': zone.GetLocalClearance(),
            'connection': zone.GetPadConnection(),
            'thermal_gap': zone.GetThermalReliefGap(),
            'thermal_spoke': zone.GetThermalReliefSpokeWidth(),
            'filled': {
                str(layer): polygons(zone.GetFilledPolysList(layer))
                for layer in zone.GetLayerSet().Seq()
                if zone.HasFilledPolysForLayer(layer)
            },
        })
    return {
        'zones': sorted(zones, key=str),
        'footprints': sorted(footprints, key=str),
        'tracks': sorted(tracks, key=str),
    }


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python kicad.py BOARD.kicad_pcb SNAPSHOT.json')
    board = pcbnew.LoadBoard(sys.argv[1])
    result = snapshot(board)
    with open(sys.argv[2], 'w') as output:
        json.dump(result, output, sort_keys=True, indent=2)
    pcbnew.SaveBoard(sys.argv[1] + '.roundtrip.kicad_pcb', board)
    print(len(result['footprints']), 'footprints;', len(result['tracks']), 'copper items')
