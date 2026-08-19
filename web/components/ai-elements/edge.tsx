import type { EdgeProps, InternalNode, Node } from "@xyflow/react"
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSimpleBezierPath,
  Position,
  useInternalNode,
} from "@xyflow/react"
import type { ReactNode } from "react"

const Temporary = ({
  id,
  label,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) => {
  const [edgePath] = getSimpleBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  })
  const labelX = (sourceX + targetX) / 2
  const labelY = (sourceY + targetY) / 2

  return (
    <>
      <BaseEdge
        className="stroke-ring stroke-1"
        id={id}
        path={edgePath}
        style={{
          strokeDasharray: "5, 5",
        }}
      />
      <EdgeLabel label={label} x={labelX} y={labelY} />
    </>
  )
}

const Static = ({ id, label, source, target, markerEnd, style }: EdgeProps) => {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!(sourceNode && targetNode)) {
    return null
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)

  const [edgePath] = getBezierPath({
    sourcePosition: sourcePos,
    sourceX: sx,
    sourceY: sy,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
  })
  const labelX = (sx + tx) / 2
  const labelY = (sy + ty) / 2

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      <EdgeLabel label={label} x={labelX} y={labelY} />
    </>
  )
}

const getHandleCoordsByPosition = (node: InternalNode<Node>, handlePosition: Position) => {
  // Choose the handle type based on position - Left is for target, Right is for source
  const handleType = handlePosition === Position.Left ? "target" : "source"

  const handle = node.internals.handleBounds?.[handleType]?.find(
    (h) => h.position === handlePosition
  )

  if (!handle) {
    return [0, 0] as const
  }

  let offsetX = handle.width / 2
  let offsetY = handle.height / 2

  // this is a tiny detail to make the markerEnd of an edge visible.
  // The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
  // Offset the path by the handle size when the handle faces right.
  switch (handlePosition) {
    case Position.Left: {
      offsetX = 0
      break
    }
    case Position.Right: {
      offsetX = handle.width
      break
    }
    case Position.Top: {
      offsetY = 0
      break
    }
    case Position.Bottom: {
      offsetY = handle.height
      break
    }
    default: {
      throw new Error(`Invalid handle position: ${handlePosition}`)
    }
  }

  const x = node.internals.positionAbsolute.x + handle.x + offsetX
  const y = node.internals.positionAbsolute.y + handle.y + offsetY

  return [x, y] as const
}

const getEdgeParams = (source: InternalNode<Node>, target: InternalNode<Node>) => {
  const sourcePos = Position.Right
  const [sx, sy] = getHandleCoordsByPosition(source, sourcePos)
  const targetPos = Position.Left
  const [tx, ty] = getHandleCoordsByPosition(target, targetPos)

  return {
    sourcePos,
    sx,
    sy,
    targetPos,
    tx,
    ty,
  }
}

const Animated = ({ id, label, source, target, markerEnd, style }: EdgeProps) => {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!(sourceNode && targetNode)) {
    return null
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode)

  const [edgePath] = getBezierPath({
    sourcePosition: sourcePos,
    sourceX: sx,
    sourceY: sy,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
  })
  const labelX = (sx + tx) / 2
  const labelY = (sy + ty) / 2

  return (
    <>
      <BaseEdge id={id} markerEnd={markerEnd} path={edgePath} style={style} />
      <EdgeLabel label={label} x={labelX} y={labelY} />
      <circle fill="var(--primary)" r="4">
        <animateMotion dur="2s" path={edgePath} repeatCount="indefinite" />
      </circle>
    </>
  )
}

function EdgeLabel({ label, x, y }: { label: ReactNode; x: number; y: number }) {
  if (!label) {
    return null
  }

  return (
    <EdgeLabelRenderer>
      <div
        className="bg-background/95 text-muted-foreground ring-border pointer-events-none absolute rounded px-2 py-1 text-xs shadow-sm ring-1"
        style={{
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
        }}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  )
}

export const Edge = {
  Animated,
  Static,
  Temporary,
}
