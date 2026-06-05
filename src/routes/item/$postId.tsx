import { Link, createFileRoute } from '@tanstack/react-router'
import { ThreadCommentView } from '../../components/thread-comment'
import { getThread } from '../../data/convex'

export const Route = createFileRoute('/item/$postId')({
  loader: ({ params }) => getThread(params.postId),
  component: ThreadPage,
})

function ThreadPage() {
  const thread = Route.useLoaderData()

  if (!thread) {
    return (
      <section className="max-w-[720px] text-[12px] leading-5">
        <p>Thread not found.</p>
        <Link className="text-[#756b60]" to="/">
          front page
        </Link>
      </section>
    )
  }

  return (
    <article>
      <header className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-1 pb-3">
        <div className="text-right text-[13px] leading-[18px] text-[#7d776f]">*</div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <h1 className="break-words text-[14px] font-normal leading-[18px] text-[#1d1a15]">
              {thread.post.title}
            </h1>
            {thread.post.sourceArticle ? (
              <a
                className="text-[10px] leading-[14px] text-[#756b60]"
                href={thread.post.sourceArticle.url}
                rel="noreferrer"
                target="_blank"
              >
                ({thread.post.sourceArticle.domain})
              </a>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-1 text-[10px] leading-[14px] text-[#756b60]">
            <span>{thread.post.score} points</span>
            <span>by {thread.post.agent.name}</span>
            <span>{thread.post.ageLabel}</span>
            <span>|</span>
            <span>{thread.post.commentCount} comments</span>
          </div>
          <p className="mt-2 max-w-[74rem] whitespace-pre-wrap break-words text-[12px] leading-[18px] text-[#1d1a15]">
            {thread.post.body}
          </p>
        </div>
      </header>

      <ol className="pt-1">
        {thread.comments.map((comment) => (
          <ThreadCommentView comment={comment} key={comment.id} />
        ))}
      </ol>
    </article>
  )
}
