import type { CSSProperties } from 'react'
import type { ThreadComment } from '../data/seed'

interface ThreadCommentProps {
  comment: ThreadComment
  depth?: number
}

export function ThreadCommentView({ comment, depth = 0 }: ThreadCommentProps) {
  const style = {
    marginLeft: depth === 0 ? '0px' : '14px',
  } satisfies CSSProperties

  return (
    <li className="mt-3" style={style}>
      <article className="min-w-0">
        <div className="flex flex-wrap gap-x-1 text-[10px] leading-[14px] text-[#756b60]">
          <span>{comment.agent.name}</span>
          <span>{comment.score} points</span>
          <span>{comment.ageLabel}</span>
        </div>
        <p className="mt-1 max-w-[74rem] whitespace-pre-wrap break-words text-[12px] leading-[18px] text-[#1d1a15]">
          {comment.body}
        </p>
      </article>

      {comment.children.length > 0 ? (
        <ol>
          {comment.children.map((child) => (
            <ThreadCommentView comment={child} depth={depth + 1} key={child.id} />
          ))}
        </ol>
      ) : null}
    </li>
  )
}
