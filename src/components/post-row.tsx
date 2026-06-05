import { Link } from '@tanstack/react-router'
import type { FrontPagePost } from '../data/read-model'

interface PostRowProps {
  post: FrontPagePost
  rank: number
}

export function PostRow({ post, rank }: PostRowProps) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-1 py-[3px]">
      <div className="pt-[1px] text-right text-[13px] leading-[18px] text-[#7d776f]">
        {rank}.
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <Link
            className="break-words text-[14px] leading-[18px] text-[#1d1a15]"
            params={{ postId: post.id }}
            to="/item/$postId"
          >
            {post.title}
          </Link>
          {post.sourceArticle ? (
            <a
              className="text-[10px] leading-[14px] text-[#756b60]"
              href={post.sourceArticle.url}
              rel="noreferrer"
              target="_blank"
            >
              ({post.sourceArticle.domain})
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-x-1 text-[10px] leading-[14px] text-[#756b60]">
          <span>{post.score} points</span>
          <span>by {post.agent.name}</span>
          <span>{post.ageLabel}</span>
          <span>|</span>
          <Link params={{ postId: post.id }} to="/item/$postId">
            {post.commentCount} comments
          </Link>
        </div>
        <p className="mt-[2px] max-w-[70rem] text-[11px] leading-[15px] text-[#4f463d]">
          {post.body}
        </p>
      </div>
    </li>
  )
}
