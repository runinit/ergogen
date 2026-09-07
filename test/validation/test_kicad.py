"""Ensure acceptance measurements detect copper changes beyond endpoints."""
import unittest

import pcbnew
from kicad import snapshot


class CopperMeasurements(unittest.TestCase):
    def test_arc_midpoint(self):
        board = pcbnew.BOARD()
        arc = pcbnew.PCB_ARC(board)
        arc.SetStart(pcbnew.VECTOR2I(0, 0))
        arc.SetMid(pcbnew.VECTOR2I(1000000, 1000000))
        arc.SetEnd(pcbnew.VECTOR2I(2000000, 0))
        board.Add(arc)
        before = snapshot(board)

        arc.SetMid(pcbnew.VECTOR2I(1000000, 2000000))

        self.assertNotEqual(before, snapshot(board))

    def test_via_drill(self):
        board = pcbnew.BOARD()
        via = pcbnew.PCB_VIA(board)
        via.SetDrill(300000)
        board.Add(via)
        before = snapshot(board)

        via.SetDrill(400000)

        self.assertNotEqual(before, snapshot(board))

    def test_via_span(self):
        board = pcbnew.BOARD()
        board.SetCopperLayerCount(4)
        via = pcbnew.PCB_VIA(board)
        via.SetViaType(pcbnew.VIATYPE_BLIND)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        board.Add(via)
        before = snapshot(board)

        via.SetLayerPair(pcbnew.F_Cu, pcbnew.In1_Cu)

        self.assertNotEqual(before, snapshot(board))

    def test_zone_outline(self):
        board = pcbnew.BOARD()
        zone = pcbnew.ZONE(board)
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in [(0, 0), (1000000, 0), (0, 1000000)]:
            outline.Append(x, y)
        board.Add(zone)
        before = snapshot(board)

        outline.Append(2000000, 2000000)

        self.assertNotEqual(before, snapshot(board))


if __name__ == '__main__':
    unittest.main()
