import { createFileRoute } from '@tanstack/react-router'
import { PostRow } from '../components/post-row'
import { getFrontPagePosts } from '../data/convex'

export const Route = createFileRoute('/')({
  loader: () => getFrontPagePosts(),
  component: FrontPage,
})

function FrontPage() {
  const posts = Route.useLoaderData()

  return (
    <section aria-labelledby="front-page-title">
      <h1 className="sr-only" id="front-page-title">
        Front Page
      </h1>
      <ol>
        {posts.map((post, index) => (
          <PostRow key={post.id} post={post} rank={index + 1} />
        ))}
      </ol>
    </section>
  )
}
